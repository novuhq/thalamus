import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../../src/anthropic/anthropic.provider.js";
import { cloudflare } from "../../src/durable/cloudflare.js";
import type { ThalamusLogger } from "../../src/logger.js";
import { MessageRole } from "../../src/types.js";
import { awsConfig } from "./_helpers.js";

const mockCreate = vi.fn();
const mockSend = vi.fn();
const mockFetch = vi.fn<typeof globalThis.fetch>();
const mockAnthropicAws = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  // biome-ignore lint/complexity/useArrowFunction: must be callable with `new`
  const MockAnthropic = function () {
    return {
      beta: {
        sessions: {
          create: mockCreate,
          events: { stream: vi.fn(), send: mockSend },
        },
        vaults: { create: vi.fn(), retrieve: vi.fn() },
      },
    };
  };
  return {
    default: MockAnthropic,
    APIError: actual.APIError,
    APIUserAbortError: actual.APIUserAbortError,
  };
});

vi.mock("@anthropic-ai/aws-sdk", () => ({
  AnthropicAws: mockAnthropicAws,
}));

mockAnthropicAws.mockImplementation(function (
  this: unknown,
  _clientConfig: Record<string, unknown>,
) {
  return {
    baseURL: "https://aws-external-anthropic.us-east-1.api.aws",
    apiKey: "aws-api-key-abc123",
    beta: {
      sessions: {
        create: mockCreate,
        events: { stream: vi.fn(), send: mockSend },
      },
      vaults: { create: vi.fn(), retrieve: vi.fn() },
    },
  };
});

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("anthropic lifecycle logging", () => {
  it("emits durable send stages when logger is configured", async () => {
    mockCreate.mockResolvedValue({ id: "sess_log" });
    mockSend.mockResolvedValue({});
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));

    const stages: string[] = [];
    const logger: ThalamusLogger = {
      debug: (_msg, ctx) => {
        if (ctx?.stage) stages.push(String(ctx.stage));
      },
      info: (_msg, ctx) => {
        if (ctx?.stage) stages.push(String(ctx.stage));
      },
      warn: () => {},
      error: () => {},
    };

    const provider = createAnthropicProvider({
      ...awsConfig,
      awsWorkspaceId: "wrkspc_log",
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
      "session.create",
      "edge.observe.start",
      "edge.observe.ok",
      "dispatch.events",
      "edge.dispatch.sent",
      "send.complete",
    ]);
  });

  it("stays silent when logger is omitted", async () => {
    mockCreate.mockResolvedValue({ id: "sess_silent" });
    mockSend.mockResolvedValue({});
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));

    const info = vi.fn();
    const provider = createAnthropicProvider({
      ...awsConfig,
      awsWorkspaceId: "wrkspc_silent",
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
    const provider = createAnthropicProvider({
      ...awsConfig,
      awsWorkspaceId: "wrkspc_handler",
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
