import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudflare } from "../../src/durable/cloudflare.js";
import { createGoogleProvider } from "../../src/google/google.provider.js";
import { MessageRole } from "../../src/types.js";
import { config, replyText, streamOf, succeeded } from "./_helpers.js";

const mockFetch = vi.fn<typeof globalThis.fetch>();

function enqueueResponse(status: "active" | "queued" = "active") {
  return new Response(JSON.stringify({ status }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("GoogleProvider — webhook / durable", () => {
  it("enqueues then posts stream parts to the webhook", async () => {
    mockFetch.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/enqueue")) return enqueueResponse("active");
      if (url.includes("/observe/")) return new Response(null, { status: 204 });
      return new Response(null, { status: 200 });
    });

    const provider = createGoogleProvider({
      ...config,
      streamAssist: () => streamOf(replyText("Hi"), succeeded()),
      createSession: async () =>
        "projects/test-project/locations/global/collections/default_collection/engines/test-engine-123/sessions/sess-edge",
      durable: cloudflare({
        url: "http://127.0.0.1:8788",
        webhook: { url: "https://app.example/webhook", secret: "secret" },
      }),
    });

    const result = await provider.send({
      messages: [{ role: MessageRole.USER, content: "hello" }],
    });

    expect(result.status).toBe("active");
    expect(result.sessionId).toContain("sessions/sess-edge");

    const urls = mockFetch.mock.calls.map(([input]) =>
      typeof input === "string" ? input : input.toString(),
    );
    expect(urls.some((url) => url.includes("/enqueue"))).toBe(true);
    expect(
      urls.filter((url) => url === "https://app.example/webhook").length,
    ).toBeGreaterThan(0);
  });

  it("returns queued without streaming when the observer is busy", async () => {
    mockFetch.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/enqueue")) return enqueueResponse("queued");
      return new Response(null, { status: 200 });
    });

    const streamAssist = vi.fn(() => streamOf(succeeded()));
    const provider = createGoogleProvider({
      ...config,
      streamAssist,
      createSession: async () => "sess-queued",
      durable: cloudflare({
        url: "http://127.0.0.1:8788",
        webhook: { url: "https://app.example/webhook", secret: "secret" },
      }),
    });

    const result = await provider.send({
      messages: [{ role: MessageRole.USER, content: "wait" }],
    });

    expect(result.status).toBe("queued");
    expect(streamAssist).not.toHaveBeenCalled();
  });
});
