import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAIProvider } from "../../src/openai/openai.provider.js";
import { MessageRole } from "../../src/types.js";
import { config, makeStream } from "./_helpers.js";

const mockResponsesCreate = vi.fn();
const mockConversationsCreate = vi.fn();

vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  // biome-ignore lint/complexity/useArrowFunction: must be callable with `new`
  const MockOpenAI = function () {
    return {
      responses: { create: mockResponsesCreate },
      conversations: { create: mockConversationsCreate },
    };
  };
  return { default: MockOpenAI, APIError: actual.APIError };
});

afterEach(() => vi.clearAllMocks());

describe("createOpenAIProvider", () => {
  it("sets provider = openai and runtimeId = inline when no promptId", () => {
    const rt = createOpenAIProvider(config);
    expect(rt.provider).toBe("openai");
    expect(rt.runtimeId).toBe("inline");
  });

  it("uses promptId as runtimeId when provided", () => {
    expect(
      createOpenAIProvider({ ...config, promptId: "pmpt_abc" }).runtimeId,
    ).toBe("pmpt_abc");
  });
});

describe("stream — new session (conversation)", () => {
  it("creates a conversation, yields stream-start with conversationId, resolves response", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_new" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_1", conversation: { id: "conv_new" } },
        },
        { type: "response.output_text.delta", delta: "Hello" },
        { type: "response.output_text.delta", delta: " world" },
        {
          type: "response.completed",
          response: {
            id: "resp_1",
            output_text: "Hello world",
            usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
          },
        },
      ]),
    );

    const parts: any[] = [];
    const response = await createOpenAIProvider(config).stream(
      { messages: [{ role: MessageRole.USER, content: "Hi" }] },
      { onPart: (p) => parts.push(p) },
    );

    expect(mockConversationsCreate).toHaveBeenCalledOnce();
    expect(parts.find((p) => p.type === "stream-start")).toMatchObject({
      sessionId: "conv_new",
    });
    expect(parts.filter((p) => p.type === "text-delta")).toHaveLength(2);

    expect(response.content).toBe("Hello world");
    expect(response.sessionId).toBe("conv_new");
    expect(response.usage?.inputTokens).toBe(5);
  });
});

describe("stream — resume session (conversation)", () => {
  it("passes conversation id when sessionId is provided, skips conversations.create", async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_2", conversation: { id: "conv_existing" } },
        },
        {
          type: "response.completed",
          response: { id: "resp_2", output_text: "ok", usage: {} },
        },
      ]),
    );

    await createOpenAIProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "next" }],
      sessionId: "conv_existing",
    });

    expect(mockConversationsCreate).not.toHaveBeenCalled();
    expect(mockResponsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ conversation: { id: "conv_existing" } }),
    );
  });
});
