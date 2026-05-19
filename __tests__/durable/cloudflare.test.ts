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

describe("cloudflare() edge observer", () => {
  it("observe sends POST /observe with params", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const backend = cloudflare(defaultOptions);
    await backend.observe({
      sessionId: "sess_1",
      streamUrl: "https://api.anthropic.com/v1/sessions/sess_1/events/stream",
      headers: { "x-api-key": "key" },
      provider: "anthropic",
      webhook: { url: "https://myapp.com/webhook", secret: "whsec_test" },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://worker.example.com/observe",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          sessionId: "sess_1",
          streamUrl:
            "https://api.anthropic.com/v1/sessions/sess_1/events/stream",
          headers: { "x-api-key": "key" },
          provider: "anthropic",
          webhook: { url: "https://myapp.com/webhook", secret: "whsec_test" },
        }),
      }),
    );
  });

  it("observe includes Authorization header when apiKey is set", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const backend = cloudflare({ ...defaultOptions, apiKey: "secret" });
    await backend.observe({
      sessionId: "sess_1",
      streamUrl: "https://example.com/sse",
      headers: {},
      provider: "anthropic",
      webhook: { url: "https://myapp.com/webhook", secret: "whsec_test" },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer secret",
        }),
      }),
    );
  });

  it("observe throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 502 }));

    const backend = cloudflare(defaultOptions);
    await expect(
      backend.observe({
        sessionId: "sess_1",
        streamUrl: "https://example.com/sse",
        headers: {},
        provider: "anthropic",
        webhook: { url: "https://myapp.com/webhook", secret: "whsec_test" },
      }),
    ).rejects.toThrow("cloudflare observe failed: 502");
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
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const backend = cloudflare({
      ...defaultOptions,
      url: "https://worker.example.com///",
    });
    await backend.observe({
      sessionId: "sess_1",
      streamUrl: "https://example.com/sse",
      headers: {},
      provider: "anthropic",
      webhook: { url: "https://myapp.com/webhook", secret: "whsec_test" },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://worker.example.com/observe",
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
