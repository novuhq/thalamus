import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAIProvider } from "../../src/openai/openai.provider.js";
import { MessageRole } from "../../src/types.js";
import { bedrockConfig, config, makeStream, sigv4Config } from "./_helpers.js";

const mockResponsesCreate = vi.fn();
const mockConversationsCreate = vi.fn();
let lastOpenAIConfig: Record<string, unknown> | undefined;

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
  return {
    default: MockOpenAI,
    APIError: actual.APIError,
    APIUserAbortError: actual.APIUserAbortError,
  };
});

afterEach(() => vi.clearAllMocks());

describe("Bedrock API Key auth — client config", () => {
  it("passes bedrock-mantle baseURL and awsBedrockApiKey to OpenAI client", async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "r1", conversation: null },
        },
        {
          type: "response.completed",
          response: { id: "r1", output_text: "", usage: {} },
        },
      ]),
    );
    await createOpenAIProvider(bedrockConfig).send({
      messages: [{ role: MessageRole.USER, content: "x" }],
    });
    expect(lastOpenAIConfig).toMatchObject({
      baseURL: "https://bedrock-mantle.us-east-1.api.aws/v1",
      apiKey: "bedrock-api-key-abc123",
    });
  });

  it("does NOT set baseURL for direct OpenAI config", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_1" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "r1", conversation: { id: "conv_1" } },
        },
        {
          type: "response.completed",
          response: { id: "r1", output_text: "", usage: {} },
        },
      ]),
    );
    await createOpenAIProvider(config).send({
      messages: [{ role: MessageRole.USER, content: "x" }],
    });
    expect(lastOpenAIConfig?.apiKey).toBe("sk-test");
    expect(lastOpenAIConfig?.baseURL).toBeUndefined();
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

    expect(response.content).toBe("Hello from Bedrock!");
    expect(response.sessionId).toBe("conv_br");
  });
});

describe("Bedrock SigV4 auth — client config", () => {
  it("passes bedrock-mantle baseURL and custom fetch to OpenAI client", async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "r1", conversation: null },
        },
        {
          type: "response.completed",
          response: { id: "r1", output_text: "", usage: {} },
        },
      ]),
    );
    await createOpenAIProvider(sigv4Config).send({
      messages: [{ role: MessageRole.USER, content: "x" }],
    });
    expect(lastOpenAIConfig?.baseURL).toBe(
      "https://bedrock-mantle.us-west-2.api.aws/v1",
    );
    expect(typeof lastOpenAIConfig?.fetch).toBe("function");
    expect(lastOpenAIConfig?.apiKey).toBe("bedrock-sigv4");
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

    expect(response.content).toBe("Signed!");
  });
});
