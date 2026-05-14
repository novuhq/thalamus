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
  return {
    default: MockOpenAI,
    APIError: actual.APIError,
    APIUserAbortError: actual.APIUserAbortError,
  };
});

afterEach(() => vi.clearAllMocks());

function setupBasicStream() {
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
}

describe("send() — basic behavior", () => {
  it("await send() returns Response, same as old stream()", async () => {
    setupBasicStream();

    const response = await createOpenAIProvider(config).send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    expect(response.content).toBe("Hello world");
    expect(response.sessionId).toBe("conv_new");
    expect(response.usage?.inputTokens).toBe(5);
  });

  it("send().text() resolves to the response text", async () => {
    setupBasicStream();

    const text = await createOpenAIProvider(config)
      .send({
        messages: [{ role: MessageRole.USER, content: "Hi" }],
      })
      .text();

    expect(text).toBe("Hello world");
  });

  it("send().sessionId resolves to the session ID", async () => {
    setupBasicStream();

    const result = createOpenAIProvider(config).send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    const sessionId = await result.sessionId;
    expect(sessionId).toBe("conv_new");
  });
});

describe("send() — onSessionEvents factory", () => {
  it("calls onSessionEvents factory and routes events through callbacks", async () => {
    setupBasicStream();

    const onTextDelta = vi.fn();
    const onFinish = vi.fn();
    const factory = vi.fn().mockReturnValue({ onTextDelta, onFinish });

    const provider = createOpenAIProvider({
      ...config,
      onSessionEvents: factory,
    });

    const response = await provider.send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    expect(factory).toHaveBeenCalledWith("<<pending>>");
    expect(onTextDelta).toHaveBeenCalledTimes(2);
    expect(onTextDelta).toHaveBeenCalledWith(
      expect.objectContaining({ type: "text-delta", text: "Hello" }),
    );
    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ type: "finish" }),
    );
    expect(response.content).toBe("Hello world");
  });

  it("passes existing sessionId to factory when provided", async () => {
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

    const factory = vi.fn().mockReturnValue({});

    const provider = createOpenAIProvider({
      ...config,
      onSessionEvents: factory,
    });

    await provider.send({
      messages: [{ role: MessageRole.USER, content: "next" }],
      sessionId: "conv_existing",
    });

    expect(factory).toHaveBeenCalledWith("conv_existing");
  });

  it("auto-starts: callbacks fire even without await (fire-and-forget)", async () => {
    setupBasicStream();

    const onFinish = vi.fn();
    const factory = vi.fn().mockReturnValue({ onFinish });

    const provider = createOpenAIProvider({
      ...config,
      onSessionEvents: factory,
    });

    const result = provider.send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    await result.response;

    expect(onFinish).toHaveBeenCalledOnce();
  });
});
