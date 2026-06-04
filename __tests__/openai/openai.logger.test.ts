import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudflare } from "../../src/durable/cloudflare.js";
import type { ThalamusLogger } from "../../src/logger.js";
import { createOpenAIProvider } from "../../src/openai/openai.provider.js";
import { MessageRole } from "../../src/types.js";
import { config, makeStream } from "./_helpers.js";

const mockResponsesCreate = vi.fn();
const mockConversationsCreate = vi.fn();
const mockFetch = vi.fn<typeof globalThis.fetch>();

vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  // biome-ignore lint/complexity/useArrowFunction: must be callable with `new`
  const MockOpenAI = function () {
    return {
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-test",
      responses: { create: mockResponsesCreate, retrieve: vi.fn() },
      conversations: { create: mockConversationsCreate },
    };
  };
  return {
    default: MockOpenAI,
    APIError: actual.APIError,
    APIUserAbortError: actual.APIUserAbortError,
  };
});

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function captureLogger(): { logger: ThalamusLogger; stages: string[] } {
  const stages: string[] = [];
  const logger: ThalamusLogger = {
    debug: (_msg, ctx) => {
      if (ctx?.stage) stages.push(String(ctx.stage));
    },
    info: (_msg, ctx) => {
      if (ctx?.stage) stages.push(String(ctx.stage));
    },
    warn: (_msg, ctx) => {
      if (ctx?.stage) stages.push(String(ctx.stage));
    },
    error: (_msg, ctx) => {
      if (ctx?.stage) stages.push(String(ctx.stage));
    },
  };
  return { logger, stages };
}

function mockEdgeDispatchStream(responseId = "resp_edge") {
  mockResponsesCreate.mockReturnValue(
    makeStream([
      {
        type: "response.created",
        response: { id: responseId },
        sequence_number: 0,
      },
    ]),
  );
}

describe("openai lifecycle logging", () => {
  it("emits durable webhook stages when logger is configured", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_edge" });
    mockEdgeDispatchStream();
    mockFetch.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/enqueue")) {
        return new Response(JSON.stringify({ status: "active" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(null, { status: 204 });
    });

    const { logger, stages } = captureLogger();
    const provider = createOpenAIProvider({
      ...config,
      logger,
      durable: cloudflare({
        url: "https://worker.example.com",
        webhook: { url: "https://app.example/webhook", secret: "secret" },
      }),
    });

    await provider.send({
      messages: [{ role: MessageRole.USER, content: "hi" }],
    });

    expect(stages).toEqual([
      "send.start",
      "conversation.create",
      "edge.enqueue",
      "send.complete",
    ]);
  });

  it("emits stream-mode stages when logger is configured", async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_stream", conversation: { id: "conv_stream" } },
          sequence_number: 0,
        },
        { type: "response.output_text.delta", delta: "Hi", sequence_number: 1 },
        {
          type: "response.completed",
          response: {
            id: "resp_stream",
            output_text: "Hi",
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
          sequence_number: 2,
        },
      ]),
    );

    const { logger, stages } = captureLogger();
    const provider = createOpenAIProvider({
      ...config,
      logger,
    });

    await provider.send({
      sessionId: "conv_stream",
      messages: [{ role: MessageRole.USER, content: "hi" }],
    });

    expect(stages).toEqual([
      "send.start",
      "dispatch.input",
      "dispatch.start",
      "dispatch.sent",
      "send.complete",
    ]);
  });

  it("stays silent when logger is omitted", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_silent" });
    mockEdgeDispatchStream("resp_silent");
    mockFetch.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/enqueue")) {
        return new Response(JSON.stringify({ status: "active" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(null, { status: 204 });
    });

    const info = vi.fn();
    const provider = createOpenAIProvider({
      ...config,
      durable: cloudflare({
        url: "https://worker.example.com",
        webhook: { url: "https://app.example/webhook", secret: "secret" },
      }),
    });

    await provider.send({
      messages: [{ role: MessageRole.USER, content: "hi" }],
    });

    expect(info).not.toHaveBeenCalled();
  });

  it("createWebhookHandler inherits provider logger", async () => {
    const stages: string[] = [];
    const provider = createOpenAIProvider({
      ...config,
      logger: {
        debug: () => {},
        info: () => {},
        warn: (_msg, ctx) => {
          if (ctx?.stage) stages.push(String(ctx.stage));
        },
        error: () => {},
      },
      onSessionEvents: () => ({}),
      durable: cloudflare({
        url: "https://worker.example.com",
        webhook: { url: "https://app.example/webhook", secret: "secret" },
      }),
    });

    const handler = provider.createWebhookHandler({ secret: "secret" });
    await handler.handleRaw("{}", null);

    expect(stages).toEqual(["webhook.missing-signature"]);
  });
});
