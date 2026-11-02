import { afterEach, describe, expect, it } from "vitest";
import { ProviderAuthError, ProviderRateLimitError } from "../../src/errors.js";
import { createOpenAIProvider } from "../../src/openai/openai.provider.js";
import { MessageRole, type StreamPart } from "../../src/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();

  return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input !== "string" && !(input instanceof URL)) {
    return input.method.toUpperCase();
  }

  return "GET";
}

function sse(events: Array<{ event: string; data: unknown }>): string {
  return events
    .map(
      (item) => `event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`,
    )
    .join("");
}

function eventStream(body: BodyInit): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function createdEvent(responseId: string) {
  return {
    event: "response.created",
    data: {
      type: "response.created",
      sequence_number: 0,
      response: { id: responseId },
    },
  };
}

function providerErrorStream(code: string, message: string): Response {
  return eventStream(
    sse([
      createdEvent("resp_err"),
      {
        event: "error",
        data: { type: "error", code, message },
      },
    ]),
  );
}

function installFetch(handlers: {
  create: () => Response;
  retrieve: () => Response;
}): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const method = requestMethod(input, init);
    calls.push(`${method} ${url}`);

    if (method === "GET" && url.includes("/responses/")) {
      return handlers.retrieve();
    }
    if (url.includes("/responses")) {
      return handlers.create();
    }

    return new Response(JSON.stringify({ id: "conv_unused" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return calls;
}

function retrieveCalls(calls: string[]): string[] {
  return calls.filter(
    (call) => call.startsWith("GET ") && call.includes("/responses/"),
  );
}

async function sendOnce(calls: string[]) {
  const parts: StreamPart[] = [];
  const pending = createOpenAIProvider({
    apiKey: "sk-test",
    model: "gpt-4o",
    logger: "silent",
    onSessionEvents: () => ({
      onPart: (part) => {
        parts.push(part);
      },
    }),
  }).send({
    sessionId: "conv_test",
    messages: [{ role: MessageRole.USER, content: "Hi" }],
  });

  return { pending, parts, calls };
}

describe("openai streamed provider errors", () => {
  it("fails a rate-limit SSE error immediately, without resuming the response", async () => {
    const calls = installFetch({
      create: () =>
        providerErrorStream("rate_limit_exceeded", "Rate limit reached"),
      retrieve: () => new Response("retrieve", { status: 500 }),
    });
    const { pending, parts } = await sendOnce(calls);

    await expect(pending).rejects.toBeInstanceOf(ProviderRateLimitError);
    await expect(pending).rejects.toMatchObject({
      message: "Rate limit reached",
    });
    expect(retrieveCalls(calls)).toEqual([]);
    expect(parts.find((part) => part.type === "error")?.error).toBeInstanceOf(
      ProviderRateLimitError,
    );
  });

  it("fails an invalid API key SSE error as ProviderAuthError, without resuming", async () => {
    const calls = installFetch({
      create: () => providerErrorStream("invalid_api_key", "Incorrect API key"),
      retrieve: () => new Response("retrieve", { status: 500 }),
    });
    const { pending, parts } = await sendOnce(calls);

    await expect(pending).rejects.toBeInstanceOf(ProviderAuthError);
    await expect(pending).rejects.toMatchObject({
      message: "Incorrect API key",
    });
    expect(retrieveCalls(calls)).toEqual([]);
    expect(parts.find((part) => part.type === "error")?.error).toBeInstanceOf(
      ProviderAuthError,
    );
  });

  it("resumes after a dropped connection once response.created has arrived", async () => {
    const encoder = new TextEncoder();
    const created = sse([createdEvent("resp_drop")]);
    let pulled = false;
    const calls = installFetch({
      create: () => {
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!pulled) {
              pulled = true;
              controller.enqueue(encoder.encode(created));

              return;
            }
            controller.error(new TypeError("socket hang up"));
          },
        });

        return eventStream(body);
      },
      retrieve: () =>
        eventStream(
          sse([
            {
              event: "response.completed",
              data: {
                type: "response.completed",
                sequence_number: 1,
                response: {
                  id: "resp_drop",
                  output_text: "Hello",
                  usage: {
                    input_tokens: 1,
                    output_tokens: 1,
                    total_tokens: 2,
                  },
                },
              },
            },
          ]),
        ),
    });

    const { pending } = await sendOnce(calls);
    const response = await pending;

    expect(response.messages).toEqual(["Hello"]);
    expect(retrieveCalls(calls).length).toBeGreaterThan(0);
  });
});
