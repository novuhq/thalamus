import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../../src/anthropic/anthropic.provider.js";
import { cloudflare } from "../../src/durable/cloudflare.js";
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
  this: any,
  clientConfig: Record<string, unknown>,
) {
  return {
    baseURL: `https://aws-external-anthropic.${clientConfig.awsRegion}.api.aws`,
    apiKey: clientConfig.apiKey,
    beta: {
      sessions: {
        create: mockCreate,
        events: { stream: vi.fn(), send: mockSend },
      },
      vaults: { create: vi.fn(), retrieve: vi.fn() },
    },
  };
});

function enqueueResponse() {
  return new Response(JSON.stringify({ status: "active" }), {
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

describe("AWS EdgeObserver auth headers", () => {
  it("passes x-api-key and anthropic-workspace-id to the edge observer", async () => {
    mockCreate.mockResolvedValue({ id: "sess_edge" });
    mockSend.mockResolvedValue({});
    mockFetch.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/enqueue")) return enqueueResponse();
      return new Response(null, { status: 204 });
    });

    const provider = createAnthropicProvider({
      ...awsConfig,
      awsWorkspaceId: "wrkspc_edge",
      durable: cloudflare({
        url: "https://worker.example.com",
        webhook: { url: "https://app.example/webhook", secret: "secret" },
      }),
    });

    await provider.send({
      messages: [{ role: MessageRole.USER, content: "hi" }],
    });

    const observeCall = mockFetch.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("/observe"),
    );
    expect(observeCall).toBeDefined();
    const observeBody = observeCall![1]?.body as string;
    expect(observeBody).toContain('"anthropic-workspace-id":"wrkspc_edge"');
    expect(observeBody).toContain('"x-api-key":"aws-api-key-abc123"');
  });
});
