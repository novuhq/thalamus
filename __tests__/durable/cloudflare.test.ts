import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudflare } from "../../src/durable/cloudflare.js";
import { encodeLiveEvent } from "../../src/durable/live.js";

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

/**
 * One network read per chunk; `open` leaves the body hanging after the chunks.
 * Like real fetch, aborting `signal` errors the body with an AbortError.
 */
function sseResponse(
  chunks: (string | Uint8Array)[],
  {
    open = false,
    onCancel = () => {},
    signal,
  }: { open?: boolean; onCancel?: () => void; signal?: AbortSignal } = {},
) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          typeof chunk === "string" ? encoder.encode(chunk) : chunk,
        );
      }
      if (!open) controller.close();
      signal?.addEventListener("abort", () => controller.error(signal.reason));
    },
    cancel: onCancel,
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const text of stream) out.push(text);
  return out;
}

const textEvent = (text: string) =>
  `event: text\ndata: ${JSON.stringify({ text })}\n\n`;
const endEvent = (reason: string) =>
  `event: end\ndata: {"reason":"${reason}"}\n\n`;

describe("cloudflare() live text stream", () => {
  it("requests GET /live/:sessionId?messageId as an event stream with auth", async () => {
    mockFetch.mockResolvedValueOnce(sseResponse([endEvent("complete")]));

    const backend = cloudflare({ ...defaultOptions, apiKey: "secret" });
    await collect(backend.live("sess/1", "sevt a"));

    expect(mockFetch).toHaveBeenCalledWith(
      "https://worker.example.com/live/sess%2F1?messageId=sevt%20a",
      expect.objectContaining({
        headers: {
          Accept: "text/event-stream",
          Authorization: "Bearer secret",
        },
      }),
    );
  });

  it("yields the catch-up text first, then each increment, skipping pings and stopping at end", async () => {
    mockFetch.mockResolvedValueOnce(
      sseResponse([
        textEvent("Let me check "),
        ": ping\n\n",
        textEvent("that."),
        endEvent("complete"),
        textEvent("never read"),
      ]),
    );

    const chunks = await collect(
      cloudflare(defaultOptions).live("sess_1", "sevt_a"),
    );

    expect(chunks).toEqual(["Let me check ", "that."]);
  });

  it.each([
    "complete",
    "interrupted",
    "aborted",
  ])("ends cleanly on end reason %s", async (reason) => {
    mockFetch.mockResolvedValueOnce(
      sseResponse([textEvent("partial"), endEvent(reason)]),
    );

    await expect(
      collect(cloudflare(defaultOptions).live("sess_1", "sevt_a")),
    ).resolves.toEqual(["partial"]);
  });

  it("yields nothing when the reply is unknown or already finished", async () => {
    mockFetch.mockResolvedValueOnce(sseResponse([endEvent("complete")]));

    await expect(
      collect(cloudflare(defaultOptions).live("sess_1", "sevt_done")),
    ).resolves.toEqual([]);
  });

  it("parses events and multi-byte text split across network reads", async () => {
    const accented = new TextEncoder().encode(textEvent("héllo"));
    const splitAt = accented.indexOf(0xc3) + 1; // inside the 2-byte "é"
    mockFetch.mockResolvedValueOnce(
      sseResponse([
        "event: te",
        'xt\ndata: {"text":"Hi "}\r\n',
        "\r\n",
        accented.slice(0, splitAt),
        accented.slice(splitAt),
        endEvent("complete"),
      ]),
    );

    const chunks = await collect(
      cloudflare(defaultOptions).live("sess_1", "sevt_a"),
    );

    expect(chunks).toEqual(["Hi ", "héllo"]);
  });

  it("ends without yielding or throwing when another reader owns the reply (409)", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 409 }));

    await expect(
      collect(cloudflare(defaultOptions).live("sess_1", "sevt_a")),
    ).resolves.toEqual([]);
  });

  it("throws on other non-ok responses", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 }));

    await expect(
      collect(cloudflare(defaultOptions).live("sess_1", "sevt_a")),
    ).rejects.toThrow("cloudflare live failed: 500");
  });

  it("throws when the stream closes before end", async () => {
    mockFetch.mockResolvedValueOnce(sseResponse([textEvent("cut off")]));

    await expect(
      collect(cloudflare(defaultOptions).live("sess_1", "sevt_a")),
    ).rejects.toThrow("cloudflare live stream closed before end");
  });

  it("passes the signal to fetch and rejects with its AbortError", async () => {
    const controller = new AbortController();
    mockFetch.mockResolvedValueOnce(
      sseResponse([textEvent("Hel")], {
        open: true,
        signal: controller.signal,
      }),
    );

    const stream = cloudflare(defaultOptions)
      .live("sess_1", "sevt_a", { signal: controller.signal })
      [Symbol.asyncIterator]();
    await expect(stream.next()).resolves.toEqual({
      value: "Hel",
      done: false,
    });
    const pending = stream.next();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("releases the connection when the consumer stops early", async () => {
    const onCancel = vi.fn();
    mockFetch.mockResolvedValueOnce(
      sseResponse([textEvent("Hel"), textEvent("lo")], {
        open: true,
        onCancel,
      }),
    );

    for await (const _ of cloudflare(defaultOptions).live("sess_1", "sevt_a")) {
      break;
    }

    expect(onCancel).toHaveBeenCalled();
  });
});

describe("encodeLiveEvent", () => {
  it("writes frames that live() reads back unchanged", async () => {
    const texts = ['say "hi"\n\n', "line\r\nbreak", "data: event: end", "é🙂"];
    mockFetch.mockResolvedValueOnce(
      sseResponse([
        ...texts.map((text) => encodeLiveEvent({ type: "text", text })),
        encodeLiveEvent({ type: "end", reason: "interrupted" }),
      ]),
    );

    await expect(
      collect(cloudflare(defaultOptions).live("sess_1", "sevt_a")),
    ).resolves.toEqual(texts);
  });
});
