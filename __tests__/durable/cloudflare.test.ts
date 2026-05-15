import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudflare } from "../../src/durable/cloudflare.js";

const mockFetch = vi.fn<typeof globalThis.fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("cloudflare() edge observer", () => {
  /* ---------- observe ---------- */

  it("observe sends POST /observe with params", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const backend = cloudflare({ url: "https://worker.example.com" });
    await backend.observe({
      sessionId: "sess_1",
      streamUrl: "https://api.anthropic.com/v1/sessions/sess_1/events/stream",
      headers: { "x-api-key": "key" },
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
        }),
      }),
    );
  });

  it("observe includes Authorization header when apiKey is set", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const backend = cloudflare({
      url: "https://worker.example.com",
      apiKey: "secret",
    });
    await backend.observe({
      sessionId: "sess_1",
      streamUrl: "https://example.com/sse",
      headers: {},
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

    const backend = cloudflare({ url: "https://worker.example.com" });
    await expect(
      backend.observe({
        sessionId: "sess_1",
        streamUrl: "https://example.com/sse",
        headers: {},
      }),
    ).rejects.toThrow("cloudflare observe failed: 502");
  });

  /* ---------- stop ---------- */

  it("stop sends DELETE /observe/:sessionId", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const backend = cloudflare({ url: "https://worker.example.com" });
    await backend.stop("sess_1");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://worker.example.com/observe/sess_1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("stop tolerates 404", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));

    const backend = cloudflare({ url: "https://worker.example.com" });
    await expect(backend.stop("gone")).resolves.toBeUndefined();
  });

  it("stop throws on non-ok, non-404 response", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 }));

    const backend = cloudflare({ url: "https://worker.example.com" });
    await expect(backend.stop("sess_1")).rejects.toThrow(
      "cloudflare stop failed: 500",
    );
  });

  it("stop encodes sessionId in URL", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const backend = cloudflare({ url: "https://worker.example.com" });
    await backend.stop("sess/with spaces");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://worker.example.com/observe/sess%2Fwith%20spaces",
      expect.any(Object),
    );
  });

  it("strips trailing slashes from base URL", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const backend = cloudflare({ url: "https://worker.example.com///" });
    await backend.observe({
      sessionId: "sess_1",
      streamUrl: "https://example.com/sse",
      headers: {},
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://worker.example.com/observe",
      expect.any(Object),
    );
  });

  /* ---------- events (WebSocket) ---------- */

  it("events() opens WebSocket with correct URL", async () => {
    let constructedUrl = "";

    class MockWebSocket {
      private handlers: Record<string, Array<(data?: unknown) => void>> = {};
      close = vi.fn();

      constructor(url: string) {
        constructedUrl = url;
        setTimeout(() => this.fire("open"), 0);
        setTimeout(() => this.fire("close"), 10);
      }

      addEventListener(event: string, handler: (data?: unknown) => void) {
        const list = this.handlers[event] ?? [];
        this.handlers[event] = list;
        list.push(handler);
      }

      private fire(event: string, data?: unknown) {
        for (const h of this.handlers[event] ?? []) h(data);
      }
    }

    vi.stubGlobal("WebSocket", MockWebSocket);

    const backend = cloudflare({ url: "https://worker.example.com" });
    const iter = backend.events("sess_1")[Symbol.asyncIterator]();

    const result = await iter.next();
    expect(result.done).toBe(true);
    expect(constructedUrl).toBe("wss://worker.example.com?sessionId=sess_1");
  });

  it("events() includes token param when apiKey is set", async () => {
    let constructedUrl = "";

    class MockWebSocket {
      private handlers: Record<string, Array<(data?: unknown) => void>> = {};
      close = vi.fn();

      constructor(url: string) {
        constructedUrl = url;
        setTimeout(() => this.fire("open"), 0);
        setTimeout(() => this.fire("close"), 10);
      }

      addEventListener(event: string, handler: (data?: unknown) => void) {
        const list = this.handlers[event] ?? [];
        this.handlers[event] = list;
        list.push(handler);
      }

      private fire(event: string, data?: unknown) {
        for (const h of this.handlers[event] ?? []) h(data);
      }
    }

    vi.stubGlobal("WebSocket", MockWebSocket);

    const backend = cloudflare({
      url: "https://worker.example.com",
      apiKey: "secret",
    });
    const iter = backend.events("sess_1")[Symbol.asyncIterator]();
    await iter.next();

    expect(constructedUrl).toBe(
      "wss://worker.example.com?sessionId=sess_1&token=secret",
    );
  });

  it("events() throws when WebSocket connection fails", async () => {
    class MockWebSocket {
      private handlers: Record<string, Array<(data?: unknown) => void>> = {};
      close = vi.fn();

      constructor() {
        setTimeout(() => this.fire("error", new Event("error")), 0);
      }

      addEventListener(event: string, handler: (data?: unknown) => void) {
        const list = this.handlers[event] ?? [];
        this.handlers[event] = list;
        list.push(handler);
      }

      private fire(event: string, data?: unknown) {
        for (const h of this.handlers[event] ?? []) h(data);
      }
    }

    vi.stubGlobal("WebSocket", MockWebSocket);

    const backend = cloudflare({ url: "https://worker.example.com" });
    const iter = backend.events("sess_1")[Symbol.asyncIterator]();

    await expect(iter.next()).rejects.toThrow("WebSocket connection failed");
  });

  it("events() yields SSE frames from WebSocket messages", async () => {
    class MockWebSocket {
      private handlers: Record<string, Array<(data?: unknown) => void>> = {};
      close = vi.fn();

      constructor() {
        setTimeout(() => this.fire("open"), 0);
        setTimeout(() => {
          this.fire("message", {
            data: JSON.stringify({
              event: "message",
              id: "1",
              data: '{"text":"hi"}',
            }),
          });
          this.fire("message", {
            data: JSON.stringify({ event: "done", id: "2", data: "{}" }),
          });
          this.fire("close");
        }, 5);
      }

      addEventListener(event: string, handler: (data?: unknown) => void) {
        const list = this.handlers[event] ?? [];
        this.handlers[event] = list;
        list.push(handler);
      }

      private fire(event: string, data?: unknown) {
        for (const h of this.handlers[event] ?? []) h(data);
      }
    }

    vi.stubGlobal("WebSocket", MockWebSocket);

    const backend = cloudflare({ url: "https://worker.example.com" });
    const frames: unknown[] = [];

    for await (const frame of backend.events("sess_1")) {
      frames.push(frame);
    }

    expect(frames).toEqual([
      { event: "message", id: "1", data: '{"text":"hi"}' },
      { event: "done", id: "2", data: "{}" },
    ]);
  });
});
