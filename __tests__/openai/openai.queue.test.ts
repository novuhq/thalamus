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

function completedResponse(
  id: string,
  convId: string,
  text: string,
  output?: object[],
) {
  return {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output: output ?? [
        {
          type: "message",
          content: [{ type: "output_text", text }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  };
}

const autoStartConfig = {
  ...config,
  onSessionEvents: () => ({}),
};

describe("sequential turns (queue)", () => {
  it("serial sends with sessionId both complete", async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_1", conversation: { id: "conv_1" } },
        },
        { type: "response.output_text.delta", delta: "first" },
        completedResponse("resp_1", "conv_1", "first"),
      ]),
    );

    const provider = createOpenAIProvider(config);
    const r1 = await provider.send({
      sessionId: "conv_1",
      messages: [{ role: MessageRole.USER, content: "A" }],
    });
    expect(r1.content).toBe("first");

    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_2", conversation: { id: "conv_1" } },
        },
        { type: "response.output_text.delta", delta: "second" },
        completedResponse("resp_2", "conv_1", "second"),
      ]),
    );

    const r2 = await provider.send({
      sessionId: "conv_1",
      messages: [{ role: MessageRole.USER, content: "B" }],
    });
    expect(r2.content).toBe("second");
    expect(mockResponsesCreate).toHaveBeenCalledTimes(2);
  });

  it("second send waits until first turn completes", async () => {
    const provider = createOpenAIProvider(config);

    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((r) => {
      releaseFirst = r;
    });

    let streamCall = 0;
    mockResponsesCreate.mockImplementation(() => {
      const gen = ++streamCall;
      return {
        [Symbol.asyncIterator]: async function* () {
          if (gen === 1) {
            yield {
              type: "response.created",
              response: { id: "resp_1", conversation: { id: "conv_1" } },
            };
            await holdFirst;
            yield { type: "response.output_text.delta", delta: "first" };
            yield completedResponse("resp_1", "conv_1", "first");
          } else {
            yield {
              type: "response.created",
              response: { id: "resp_2", conversation: { id: "conv_1" } },
            };
            yield { type: "response.output_text.delta", delta: "second" };
            yield completedResponse("resp_2", "conv_1", "second");
          }
        },
      };
    });

    const first = provider.send({
      sessionId: "conv_1",
      messages: [{ role: MessageRole.USER, content: "A" }],
    });
    void first.response;

    await vi.waitFor(() =>
      expect(mockResponsesCreate).toHaveBeenCalledTimes(1),
    );

    const second = provider.send({
      sessionId: "conv_1",
      messages: [{ role: MessageRole.USER, content: "B" }],
    });
    void second.response;

    releaseFirst();
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1.content).toBe("first");
    expect(r2.content).toBe("second");
    expect(mockResponsesCreate).toHaveBeenCalledTimes(2);
  });

  it("toolResults bypass the queue", async () => {
    const provider = createOpenAIProvider(config);

    let streamCall = 0;
    mockResponsesCreate.mockImplementation(() => {
      const gen = ++streamCall;
      return {
        [Symbol.asyncIterator]: async function* () {
          if (gen === 1) {
            yield {
              type: "response.created",
              response: { id: "resp_1", conversation: { id: "conv_1" } },
            };
            yield {
              type: "response.output_item.done",
              item: {
                type: "mcp_approval_request",
                id: "appr_1",
                server_label: "github",
                name: "create_issue",
                arguments: '{"title":"Bug"}',
              },
            };
            yield completedResponse("resp_1", "conv_1", "", [
              {
                type: "mcp_approval_request",
                id: "appr_1",
                server_label: "github",
                name: "create_issue",
              },
            ]);
          } else if (gen === 2) {
            yield {
              type: "response.created",
              response: { id: "resp_2", conversation: { id: "conv_1" } },
            };
            yield { type: "response.output_text.delta", delta: "approved" };
            yield completedResponse("resp_2", "conv_1", "approved");
          } else {
            yield {
              type: "response.created",
              response: { id: "resp_3", conversation: { id: "conv_1" } },
            };
            yield { type: "response.output_text.delta", delta: "after" };
            yield completedResponse("resp_3", "conv_1", "after");
          }
        },
      };
    });

    const first = await provider.send({
      sessionId: "conv_1",
      messages: [{ role: MessageRole.USER, content: "use tool" }],
    });
    expect(first.finishReason).toBe("requires-action");

    const queued = provider.send({
      sessionId: "conv_1",
      messages: [{ role: MessageRole.USER, content: "follow up" }],
    });
    void queued.response;

    const approval = await provider.send({
      sessionId: "conv_1",
      messages: [],
      toolResults: [{ toolUseId: "appr_1", approved: true }],
    });
    expect(approval.finishReason).toBe("stop");

    const queuedResult = await queued;
    expect(queuedResult.content).toBe("after");
  });

  it("new session (no sessionId) fires immediately", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_new" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_1", conversation: { id: "conv_new" } },
        },
        { type: "response.output_text.delta", delta: "hello" },
        completedResponse("resp_1", "conv_new", "hello"),
      ]),
    );

    const result = await createOpenAIProvider(config).send({
      messages: [{ role: MessageRole.USER, content: "hi" }],
    });
    expect(result.content).toBe("hello");
  });

  it("emits status-change queued when message is waiting", async () => {
    const onStatusChange = vi.fn();
    const provider = createOpenAIProvider({
      ...autoStartConfig,
      onSessionEvents: () => ({ onStatusChange }),
    });

    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((r) => {
      releaseFirst = r;
    });

    let streamCall = 0;
    mockResponsesCreate.mockImplementation(() => {
      const gen = ++streamCall;
      return {
        [Symbol.asyncIterator]: async function* () {
          if (gen === 1) {
            yield {
              type: "response.created",
              response: { id: "resp_1", conversation: { id: "conv_1" } },
            };
            await holdFirst;
            yield { type: "response.output_text.delta", delta: "first" };
            yield completedResponse("resp_1", "conv_1", "first");
          } else {
            yield {
              type: "response.created",
              response: { id: "resp_2", conversation: { id: "conv_1" } },
            };
            yield { type: "response.output_text.delta", delta: "second" };
            yield completedResponse("resp_2", "conv_1", "second");
          }
        },
      };
    });

    const first = provider.send({
      sessionId: "conv_1",
      messages: [{ role: MessageRole.USER, content: "A" }],
    });
    void first.response;

    await vi.waitFor(() =>
      expect(mockResponsesCreate).toHaveBeenCalledTimes(1),
    );

    const second = provider.send({
      sessionId: "conv_1",
      messages: [{ role: MessageRole.USER, content: "B" }],
    });
    void second.response;

    await vi.waitFor(() =>
      expect(onStatusChange).toHaveBeenCalledWith(
        expect.objectContaining({ status: "queued" }),
      ),
    );

    releaseFirst();
    await Promise.all([first, second]);
  });
});
