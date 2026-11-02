import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudflare } from "../../src/durable/cloudflare.js";
import { ThalamusError } from "../../src/errors.js";
import {
  createOpenAIProvider,
  type OpenAIProviderConfig,
} from "../../src/openai/openai.provider.js";
import { MessageRole } from "../../src/types.js";
import { bedrockConfig, config, makeStream, sigv4Config } from "./_helpers.js";

const mockResponsesCreate = vi.fn();
const mockConversationsCreate = vi.fn();
const mockFetch = vi.fn<typeof globalThis.fetch>();
let lastOpenAIConfig: Record<string, unknown> | undefined;

const { bearerBedrock, awsBedrock, awsLoads } = vi.hoisted(() => {
  const loads = { count: 0 };
  return {
    bearerBedrock: vi.fn(() => ({ kind: "bearer" as const })),
    awsBedrock: vi.fn(() => ({ kind: "aws" as const })),
    awsLoads: loads,
  };
});

vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  // biome-ignore lint/complexity/useArrowFunction: must be callable with `new`
  const MockOpenAI = function (config: Record<string, unknown>) {
    lastOpenAIConfig = config;
    return {
      responses: { create: mockResponsesCreate },
      conversations: { create: mockConversationsCreate },
    };
  };
  return { ...actual, default: MockOpenAI };
});

vi.mock("openai/providers/bedrock", () => ({ bedrock: bearerBedrock }));
vi.mock("openai/providers/bedrock/aws", () => {
  awsLoads.count += 1;
  return { bedrock: awsBedrock };
});

afterEach(() => {
  lastOpenAIConfig = undefined;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function completedStream(id: string) {
  return makeStream([
    {
      type: "response.created",
      response: { id, conversation: null },
    },
    {
      type: "response.completed",
      response: { id, output_text: "ok", usage: {} },
    },
  ]);
}

describe("Bedrock API Key auth — client config", () => {
  it("constructs OpenAI with the bearer bedrock provider only", async () => {
    mockResponsesCreate.mockReturnValue(completedStream("resp_key"));

    await createOpenAIProvider(bedrockConfig).send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    expect(bearerBedrock).toHaveBeenCalledWith({
      region: "us-east-1",
      apiKey: "bedrock-api-key-abc123",
      baseURL: null,
    });
    expect(lastOpenAIConfig).toEqual({
      provider: bearerBedrock.mock.results[0]?.value,
    });
    expect(lastOpenAIConfig).not.toHaveProperty("apiKey");
    expect(lastOpenAIConfig).not.toHaveProperty("baseURL");
    expect(awsLoads.count).toBe(0);
    expect(awsBedrock).not.toHaveBeenCalled();
  });

  it("does NOT set baseURL for direct OpenAI config", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_direct" });
    mockResponsesCreate.mockReturnValue(completedStream("resp_direct"));

    await createOpenAIProvider(config).send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    expect(lastOpenAIConfig).toEqual({ apiKey: "sk-test" });
    expect(lastOpenAIConfig?.baseURL).toBeUndefined();
    expect(bearerBedrock).not.toHaveBeenCalled();
    expect(awsBedrock).not.toHaveBeenCalled();
  });
});

describe("Bedrock API Key auth — streaming", () => {
  it("streams successfully via bedrock-mantle endpoint", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_br" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_br", conversation: { id: "conv_br" } },
        },
        { type: "response.output_text.delta", delta: "Hello from Bedrock!" },
        {
          type: "response.completed",
          response: {
            id: "resp_br",
            output_text: "Hello from Bedrock!",
            usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
          },
        },
      ]),
    );

    const parts: any[] = [];
    const response = await createOpenAIProvider({
      ...bedrockConfig,
      onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
    }).send({ messages: [{ role: MessageRole.USER, content: "Hi" }] });

    expect(response.messages).toEqual(["Hello from Bedrock!"]);
    expect(response.sessionId).toBe("conv_br");
  });
});

describe("Bedrock SigV4 auth — client config", () => {
  it("constructs OpenAI with the aws bedrock provider only", async () => {
    mockResponsesCreate.mockReturnValue(completedStream("resp_sig"));

    await createOpenAIProvider(sigv4Config).send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    expect(awsBedrock).toHaveBeenCalledWith({
      region: "us-west-2",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      sessionToken: undefined,
      baseURL: null,
    });
    expect(lastOpenAIConfig).toEqual({
      provider: awsBedrock.mock.results[0]?.value,
    });
    expect(Object.keys(lastOpenAIConfig ?? {})).toEqual(["provider"]);
  });
});

describe("Bedrock — no Conversations API (previous_response_id fallback)", () => {
  it("does NOT call conversations.create on Bedrock config", async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_br_f1", conversation: null },
        },
        { type: "response.output_text.delta", delta: "hi" },
        {
          type: "response.completed",
          response: { id: "resp_br_f1", output_text: "hi", usage: {} },
        },
      ]),
    );

    await createOpenAIProvider(bedrockConfig).send({
      messages: [{ role: MessageRole.USER, content: "hello" }],
    });

    expect(mockConversationsCreate).not.toHaveBeenCalled();
  });

  it("uses response ID as sessionId when no conversation is returned", async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_br_f2", conversation: null },
        },
        {
          type: "response.completed",
          response: { id: "resp_br_f2", output_text: "ok", usage: {} },
        },
      ]),
    );

    const response = await createOpenAIProvider(bedrockConfig).send({
      messages: [{ role: MessageRole.USER, content: "hi" }],
    });
    expect(response.sessionId).toBe("resp_br_f2");
  });

  it("passes previous_response_id on session resume", async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_br_f3", conversation: null },
        },
        {
          type: "response.completed",
          response: { id: "resp_br_f3", output_text: "ok", usage: {} },
        },
      ]),
    );

    await createOpenAIProvider(bedrockConfig).send({
      messages: [{ role: MessageRole.USER, content: "next" }],
      sessionId: "resp_br_prev",
    });

    expect(mockConversationsCreate).not.toHaveBeenCalled();
    expect(mockResponsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ previous_response_id: "resp_br_prev" }),
      expect.objectContaining({}),
    );
    expect(mockResponsesCreate.mock.calls[0][0].conversation).toBeUndefined();
  });
});

describe("Bedrock SigV4 auth — streaming", () => {
  it("streams successfully via SigV4-signed requests", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_sv4" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_sv4", conversation: { id: "conv_sv4" } },
        },
        { type: "response.output_text.delta", delta: "Signed!" },
        {
          type: "response.completed",
          response: { id: "resp_sv4", output_text: "Signed!", usage: {} },
        },
      ]),
    );

    const parts: any[] = [];
    const response = await createOpenAIProvider({
      ...sigv4Config,
      onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
    }).send({ messages: [{ role: MessageRole.USER, content: "Hi" }] });

    expect(response.messages).toEqual(["Signed!"]);
  });
});

describe("Bedrock API key auth — edge observer", () => {
  it("sends the bedrock api key on the observe Authorization header", async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_edge" },
          sequence_number: 0,
        },
      ]),
    );
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
    vi.stubGlobal("fetch", mockFetch);

    await createOpenAIProvider({
      ...bedrockConfig,
      durable: cloudflare({
        url: "https://worker.example.com",
        webhook: { url: "https://app.example/webhook", secret: "secret" },
      }),
    }).send({
      messages: [{ role: MessageRole.USER, content: "hi" }],
    });

    const observe = mockFetch.mock.calls.find((call) =>
      String(call[0]).includes("/observe"),
    );
    const body = JSON.parse(String((observe?.[1] as RequestInit).body));
    expect(body.headers.Authorization).toBe("Bearer bedrock-api-key-abc123");
  });
});

describe("Bedrock auth — missing credentials", () => {
  it("throws when awsRegion is set without a key or credentials", () => {
    expect(() =>
      createOpenAIProvider({
        awsRegion: "us-east-1",
      } as OpenAIProviderConfig),
    ).toThrow(ThalamusError);
  });
});
