import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamCallbacks, StreamPart } from "../../src/types.js";
import { createWebhookHandler } from "../../src/webhook/index.js";

const SECRET = "whsec_test_secret";

async function sign(
  body: string,
  secret: string,
  timestamp: number,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${body}`),
  );
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `t=${timestamp},v1=${hex}`;
}

function makePayload(event: StreamPart, overrides?: Record<string, unknown>) {
  return JSON.stringify({
    sessionId: "sess_123",
    runId: "run_test_1",
    sequence: 1,
    timestamp: Math.floor(Date.now() / 1000),
    provider: "anthropic",
    metadata: { orgId: "org_1" },
    event,
    ...overrides,
  });
}

describe("createWebhookHandler", () => {
  let realDateNow: () => number;

  beforeEach(() => {
    realDateNow = Date.now;
  });

  afterEach(() => {
    Date.now = realDateNow;
    vi.restoreAllMocks();
  });

  describe("signature verification", () => {
    it("rejects missing signature header", async () => {
      const handler = createWebhookHandler({
        secret: SECRET,
        onSessionEvents: () => ({}),
      });

      const result = await handler.handleRaw("{}", null);
      expect(result.status).toBe(401);
      expect(JSON.parse(result.body!).error).toMatch(/Missing/);
    });

    it("rejects invalid signature format", async () => {
      const handler = createWebhookHandler({
        secret: SECRET,
        onSessionEvents: () => ({}),
      });

      const result = await handler.handleRaw("{}", "garbage");
      expect(result.status).toBe(401);
      expect(JSON.parse(result.body!).error).toMatch(/Invalid/);
    });

    it("rejects wrong secret", async () => {
      const handler = createWebhookHandler({
        secret: SECRET,
        onSessionEvents: () => ({}),
      });

      const body = makePayload({ type: "text-delta", text: "hi" });
      const timestamp = Math.floor(Date.now() / 1000);
      const sig = await sign(body, "wrong_secret", timestamp);

      const result = await handler.handleRaw(body, sig);
      expect(result.status).toBe(401);
    });

    it("rejects expired timestamp", async () => {
      const handler = createWebhookHandler({
        secret: SECRET,
        tolerance: 300,
        onSessionEvents: () => ({}),
      });

      const body = makePayload({ type: "text-delta", text: "hi" });
      const oldTimestamp = Math.floor(Date.now() / 1000) - 600;
      const sig = await sign(body, SECRET, oldTimestamp);

      const result = await handler.handleRaw(body, sig);
      expect(result.status).toBe(401);
    });

    it("accepts valid signature", async () => {
      const handler = createWebhookHandler({
        secret: SECRET,
        onSessionEvents: () => ({}),
      });

      const body = makePayload({ type: "text-delta", text: "hi" });
      const timestamp = Math.floor(Date.now() / 1000);
      const sig = await sign(body, SECRET, timestamp);

      const result = await handler.handleRaw(body, sig);
      expect(result.status).toBe(200);
    });
  });

  describe("event dispatch", () => {
    it("calls onSessionEvents with sessionId, runId, and metadata", async () => {
      const factory = vi.fn<
        (s: string, r: string, m: Record<string, string>) => StreamCallbacks
      >(() => ({}));
      const handler = createWebhookHandler({
        secret: SECRET,
        onSessionEvents: factory,
      });

      const body = makePayload({ type: "text-delta", text: "hi" });
      const timestamp = Math.floor(Date.now() / 1000);
      const sig = await sign(body, SECRET, timestamp);

      await handler.handleRaw(body, sig);

      expect(factory).toHaveBeenCalledWith("sess_123", "run_test_1", {
        orgId: "org_1",
      });
    });

    it("falls back to empty runId when payload omits it", async () => {
      const factory = vi.fn<
        (s: string, r: string, m: Record<string, string>) => StreamCallbacks
      >(() => ({}));
      const handler = createWebhookHandler({
        secret: SECRET,
        onSessionEvents: factory,
      });

      const body = JSON.stringify({
        sessionId: "sess_legacy",
        sequence: 1,
        timestamp: Math.floor(Date.now() / 1000),
        provider: "anthropic",
        metadata: {},
        event: { type: "text-delta", text: "hi" },
      });
      const timestamp = Math.floor(Date.now() / 1000);
      const sig = await sign(body, SECRET, timestamp);

      const result = await handler.handleRaw(body, sig);

      expect(result.status).toBe(200);
      expect(factory).toHaveBeenCalledWith("sess_legacy", "", {});
    });

    it("forwards runId from payload to onSessionEvents factory", async () => {
      const factory = vi.fn<
        (s: string, r: string, m: Record<string, string>) => StreamCallbacks
      >(() => ({}));
      const handler = createWebhookHandler({
        secret: SECRET,
        onSessionEvents: factory,
      });

      const body = makePayload(
        { type: "text-delta", text: "hi" },
        { runId: "run_42" },
      );
      const timestamp = Math.floor(Date.now() / 1000);
      const sig = await sign(body, SECRET, timestamp);

      await handler.handleRaw(body, sig);

      expect(factory).toHaveBeenCalledWith(
        "sess_123",
        "run_42",
        expect.any(Object),
      );
    });

    it("dispatches text-delta to onTextDelta", async () => {
      const onTextDelta = vi.fn();
      const handler = createWebhookHandler({
        secret: SECRET,
        onSessionEvents: () => ({ onTextDelta }),
      });

      const event: StreamPart = { type: "text-delta", text: "hello" };
      const body = makePayload(event);
      const timestamp = Math.floor(Date.now() / 1000);
      const sig = await sign(body, SECRET, timestamp);

      await handler.handleRaw(body, sig);

      expect(onTextDelta).toHaveBeenCalledWith(event);
    });

    it("dispatches finish to onFinish", async () => {
      const onFinish = vi.fn();
      const handler = createWebhookHandler({
        secret: SECRET,
        onSessionEvents: () => ({ onFinish }),
      });

      const event: StreamPart = {
        type: "finish",
        response: {
          content: "done",
          finishReason: "stop",
          sessionId: "sess_123",
        },
      };
      const body = makePayload(event);
      const timestamp = Math.floor(Date.now() / 1000);
      const sig = await sign(body, SECRET, timestamp);

      await handler.handleRaw(body, sig);

      expect(onFinish).toHaveBeenCalledWith(event);
    });

    it("calls onPart for every event type", async () => {
      const onPart = vi.fn();
      const handler = createWebhookHandler({
        secret: SECRET,
        onSessionEvents: () => ({ onPart }),
      });

      const event: StreamPart = { type: "text-delta", text: "x" };
      const body = makePayload(event);
      const timestamp = Math.floor(Date.now() / 1000);
      const sig = await sign(body, SECRET, timestamp);

      await handler.handleRaw(body, sig);

      expect(onPart).toHaveBeenCalledWith(event);
    });

    it("returns 500 when callback throws", async () => {
      const handler = createWebhookHandler({
        secret: SECRET,
        onSessionEvents: () => ({
          onTextDelta: () => {
            throw new Error("boom");
          },
        }),
      });

      const body = makePayload({ type: "text-delta", text: "hi" });
      const timestamp = Math.floor(Date.now() / 1000);
      const sig = await sign(body, SECRET, timestamp);

      const result = await handler.handleRaw(body, sig);
      expect(result.status).toBe(500);
      expect(JSON.parse(result.body!).error).toMatch(/Callback/);
    });
  });

  describe("payload validation", () => {
    it("rejects malformed JSON", async () => {
      const handler = createWebhookHandler({
        secret: SECRET,
        onSessionEvents: () => ({}),
      });

      const body = "not json{";
      const timestamp = Math.floor(Date.now() / 1000);
      const sig = await sign(body, SECRET, timestamp);

      const result = await handler.handleRaw(body, sig);
      expect(result.status).toBe(400);
      expect(JSON.parse(result.body!).error).toMatch(/Malformed/);
    });

    it("rejects missing sessionId", async () => {
      const handler = createWebhookHandler({
        secret: SECRET,
        onSessionEvents: () => ({}),
      });

      const body = JSON.stringify({ event: { type: "text-delta", text: "x" } });
      const timestamp = Math.floor(Date.now() / 1000);
      const sig = await sign(body, SECRET, timestamp);

      const result = await handler.handleRaw(body, sig);
      expect(result.status).toBe(400);
      expect(JSON.parse(result.body!).error).toMatch(/Missing/);
    });

    it("rejects missing event", async () => {
      const handler = createWebhookHandler({
        secret: SECRET,
        onSessionEvents: () => ({}),
      });

      const body = JSON.stringify({ sessionId: "sess_1" });
      const timestamp = Math.floor(Date.now() / 1000);
      const sig = await sign(body, SECRET, timestamp);

      const result = await handler.handleRaw(body, sig);
      expect(result.status).toBe(400);
    });
  });

  describe("handle() Web Request adapter", () => {
    it("rejects non-POST", async () => {
      const handler = createWebhookHandler({
        secret: SECRET,
        onSessionEvents: () => ({}),
      });

      const req = new Request("http://localhost/webhook", { method: "GET" });
      const res = await handler.handle(req);
      expect(res.status).toBe(405);
    });

    it("processes valid POST request", async () => {
      const onTextDelta = vi.fn();
      const handler = createWebhookHandler({
        secret: SECRET,
        onSessionEvents: () => ({ onTextDelta }),
      });

      const body = makePayload({ type: "text-delta", text: "hi" });
      const timestamp = Math.floor(Date.now() / 1000);
      const sig = await sign(body, SECRET, timestamp);

      const req = new Request("http://localhost/webhook", {
        method: "POST",
        body,
        headers: { "X-Thalamus-Signature": sig },
      });
      const res = await handler.handle(req);

      expect(res.status).toBe(200);
      expect(onTextDelta).toHaveBeenCalled();
    });
  });
});
