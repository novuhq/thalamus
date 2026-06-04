import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudflare } from "../../src/durable/cloudflare.js";

const mockFetch = vi.fn<typeof globalThis.fetch>();

const defaultOptions = {
  url: "https://worker.example.com",
  webhook: { url: "https://myapp.com/webhook", secret: "whsec_test" },
};

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const enqueueParams = {
  sessionId: "sess_1",
  runId: "run_1",
  turnId: "turn_1",
  provider: "anthropic",
  request: {
    messages: [{ role: "user" as const, content: "hello" }],
    sessionId: "sess_1",
  },
  webhook: { url: "https://myapp.com/webhook", secret: "whsec_test" },
};

const observeParams = {
  sessionId: "sess_1",
  runId: "run_1",
  turnId: "turn_1",
  streamUrl: "https://api.anthropic.com/v1/sessions/sess_1/events/stream",
  headers: { "x-api-key": "key" },
  provider: "anthropic",
  webhook: { url: "https://myapp.com/webhook", secret: "whsec_test" },
};

function enqueueResponse(status: "active" | "queued" = "active") {
  return new Response(JSON.stringify({ status }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("cloudflare() edge observer", () => {
  it("enqueue sends POST /enqueue and returns status", async () => {
    mockFetch.mockResolvedValueOnce(enqueueResponse("active"));

    const backend = cloudflare(defaultOptions);
    const result = await backend.enqueue(enqueueParams);

    expect(result).toEqual({ status: "active" });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://worker.example.com/enqueue",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(enqueueParams),
      }),
    );
  });

  it("enqueue returns queued status", async () => {
    mockFetch.mockResolvedValueOnce(enqueueResponse("queued"));

    const backend = cloudflare(defaultOptions);
    const result = await backend.enqueue(enqueueParams);

    expect(result).toEqual({ status: "queued" });
  });

  it("enqueue includes Authorization header when apiKey is set", async () => {
    mockFetch.mockResolvedValueOnce(enqueueResponse());

    const backend = cloudflare({ ...defaultOptions, apiKey: "secret" });
    await backend.enqueue(enqueueParams);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer secret",
        }),
      }),
    );
  });

  it("enqueue throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 502 }));

    const backend = cloudflare(defaultOptions);
    await expect(backend.enqueue(enqueueParams)).rejects.toThrow(
      "cloudflare enqueue failed: 502",
    );
  });

  it("observe sends POST /observe", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const backend = cloudflare(defaultOptions);
    await backend.observe(observeParams);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://worker.example.com/observe",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(observeParams),
      }),
    );
  });

  it("observe throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 502 }));

    const backend = cloudflare(defaultOptions);
    await expect(backend.observe(observeParams)).rejects.toThrow(
      "cloudflare observe failed: 502",
    );
  });

  it("stop sends DELETE /observe/:sessionId", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const backend = cloudflare(defaultOptions);
    await backend.stop("sess_1");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://worker.example.com/observe/sess_1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("stop tolerates 404", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));

    const backend = cloudflare(defaultOptions);
    await expect(backend.stop("gone")).resolves.toBeUndefined();
  });

  it("stop throws on non-ok, non-404 response", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 }));

    const backend = cloudflare(defaultOptions);
    await expect(backend.stop("sess_1")).rejects.toThrow(
      "cloudflare stop failed: 500",
    );
  });

  it("stop encodes sessionId in URL", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const backend = cloudflare(defaultOptions);
    await backend.stop("sess/with spaces");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://worker.example.com/observe/sess%2Fwith%20spaces",
      expect.any(Object),
    );
  });

  it("strips trailing slashes from base URL", async () => {
    mockFetch.mockResolvedValueOnce(enqueueResponse());

    const backend = cloudflare({
      ...defaultOptions,
      url: "https://worker.example.com///",
    });
    await backend.enqueue(enqueueParams);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://worker.example.com/enqueue",
      expect.any(Object),
    );
  });

  it("exposes webhook config from options", () => {
    const backend = cloudflare(defaultOptions);
    expect(backend.webhook).toEqual({
      url: "https://myapp.com/webhook",
      secret: "whsec_test",
    });
  });
});
