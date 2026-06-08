import { afterEach, describe, expect, it, vi } from "vitest";
import { ThalamusError } from "../../src/errors.js";
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

afterEach(() => vi.clearAllMocks());

function completedResponse(
  id: string,
  _convId: string,
  text: string,
  output?: object[],
) {
  return {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output_text: text,
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

function simpleStream(respId: string, convId: string, text: string) {
  return makeStream([
    {
      type: "response.created",
      response: { id: respId, conversation: { id: convId } },
    },
    { type: "response.output_text.delta", delta: text },
    completedResponse(respId, convId, text),
  ]);
}

const autoStartConfig = {
  ...config,
  onSessionEvents: () => ({}),
};

describe("sequential turns (queue)", () => {
  it("serial sends with sessionId both complete", async () => {
    mockResponsesCreate.mockReturnValue(
      simpleStream("resp_1", "conv_1", "first"),
    );

    const provider = createOpenAIProvider(config);
    const r1 = await provider.send({
      sessionId: "conv_1",
      messages: [{ role: MessageRole.USER, content: "A" }],
    });
    expect(r1.content).toBe("first");

    mockResponsesCreate.mockReturnValue(
      simpleStream("resp_2", "conv_1", "second"),
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

  it("three concurrent sends maintain FIFO order", async () => {
    const provider = createOpenAIProvider(config);
    const order: number[] = [];

    const barriers: Array<() => void> = [];
    let streamCall = 0;
    mockResponsesCreate.mockImplementation(() => {
      const gen = ++streamCall;
      return {
        [Symbol.asyncIterator]: async function* () {
          order.push(gen);
          const gate = new Promise<void>((r) => barriers.push(r));
          yield {
            type: "response.created",
            response: { id: `resp_${gen}`, conversation: { id: "conv_1" } },
          };
          await gate;
          yield { type: "response.output_text.delta", delta: `msg${gen}` };
          yield completedResponse(`resp_${gen}`, "conv_1", `msg${gen}`);
        },
      };
    });

    const sends = [1, 2, 3].map((n) =>
      provider.send({
        sessionId: "conv_1",
        messages: [{ role: MessageRole.USER, content: `${n}` }],
      }),
    );
    for (const s of sends) void s.response;

    await vi.waitFor(() =>
      expect(mockResponsesCreate).toHaveBeenCalledTimes(1),
    );
    expect(order).toEqual([1]);

    barriers[0]();
    await vi.waitFor(() =>
      expect(mockResponsesCreate).toHaveBeenCalledTimes(2),
    );
    expect(order).toEqual([1, 2]);

    barriers[1]();
    await vi.waitFor(() =>
      expect(mockResponsesCreate).toHaveBeenCalledTimes(3),
    );
    expect(order).toEqual([1, 2, 3]);

    barriers[2]();
    const results = await Promise.all(sends);
    expect(results.map((r) => r.content)).toEqual(["msg1", "msg2", "msg3"]);
  });

  it("different sessions don't block each other", async () => {
    const provider = createOpenAIProvider(config);

    let releaseA!: () => void;
    const holdA = new Promise<void>((r) => {
      releaseA = r;
    });

    let streamCall = 0;
    mockResponsesCreate.mockImplementation(() => {
      const gen = ++streamCall;
      return {
        [Symbol.asyncIterator]: async function* () {
          if (gen === 1) {
            yield {
              type: "response.created",
              response: { id: "resp_a", conversation: { id: "conv_a" } },
            };
            await holdA;
            yield completedResponse("resp_a", "conv_a", "A done");
          } else {
            yield {
              type: "response.created",
              response: { id: "resp_b", conversation: { id: "conv_b" } },
            };
            yield completedResponse("resp_b", "conv_b", "B done");
          }
        },
      };
    });

    const sendA = provider.send({
      sessionId: "conv_a",
      messages: [{ role: MessageRole.USER, content: "A" }],
    });
    void sendA.response;

    await vi.waitFor(() =>
      expect(mockResponsesCreate).toHaveBeenCalledTimes(1),
    );

    const sendB = provider.send({
      sessionId: "conv_b",
      messages: [{ role: MessageRole.USER, content: "B" }],
    });

    const resultB = await sendB;
    expect(resultB.content).toBe("B done");
    expect(mockResponsesCreate).toHaveBeenCalledTimes(2);

    releaseA();
    const resultA = await sendA;
    expect(resultA.content).toBe("A done");
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
      toolResults: [{ toolUseId: "appr_1", content: [], approved: true }],
    });
    expect(approval.finishReason).toBe("stop");

    const queuedResult = await queued;
    expect(queuedResult.content).toBe("after");
  });

  it("requires-action holds lock — queued message does not dispatch", async () => {
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
                server_label: "srv",
                name: "tool",
                arguments: "{}",
              },
            };
            yield completedResponse("resp_1", "conv_1", "", [
              {
                type: "mcp_approval_request",
                id: "appr_1",
                server_label: "srv",
                name: "tool",
              },
            ]);
          } else {
            yield {
              type: "response.created",
              response: { id: `resp_${gen}`, conversation: { id: "conv_1" } },
            };
            yield completedResponse(`resp_${gen}`, "conv_1", "next");
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

    await new Promise((r) => setTimeout(r, 50));
    expect(mockResponsesCreate).toHaveBeenCalledTimes(1);

    // Force-release via toolResults to unblock
    mockResponsesCreate.mockReturnValue(
      simpleStream("resp_unblock", "conv_1", "unblocked"),
    );
    await provider.send({
      sessionId: "conv_1",
      messages: [],
      toolResults: [{ toolUseId: "appr_1", content: [], approved: true }],
    });
    await queued;
  });

  it("stream error releases lock — next queued message proceeds", async () => {
    const provider = createOpenAIProvider(config);

    let streamCall = 0;
    mockResponsesCreate.mockImplementation(() => {
      const gen = ++streamCall;
      return {
        [Symbol.asyncIterator]: async function* () {
          if (gen === 1) {
            throw new ThalamusError("simulated fatal", {
              provider: "openai",
              isRetryable: false,
            });
          } else {
            yield {
              type: "response.created",
              response: { id: "resp_2", conversation: { id: "conv_1" } },
            };
            yield { type: "response.output_text.delta", delta: "recovered" };
            yield completedResponse("resp_2", "conv_1", "recovered");
          }
        },
      };
    });

    const first = provider.send({
      sessionId: "conv_1",
      messages: [{ role: MessageRole.USER, content: "A" }],
    });
    first.response.catch(() => {});

    await vi.waitFor(() =>
      expect(mockResponsesCreate).toHaveBeenCalledTimes(1),
    );

    const second = provider.send({
      sessionId: "conv_1",
      messages: [{ role: MessageRole.USER, content: "B" }],
    });
    void second.response;

    await expect(first.response).rejects.toThrow();

    const r2 = await second;
    expect(r2.content).toBe("recovered");
  });

  it("new session (no sessionId) fires immediately", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_new" });
    mockResponsesCreate.mockReturnValue(
      simpleStream("resp_1", "conv_new", "hello"),
    );

    const result = await createOpenAIProvider(config).send({
      messages: [{ role: MessageRole.USER, content: "hi" }],
    });
    expect(result.content).toBe("hello");
  });

  it("bootstrap dedup — two sends without sessionId share same conversation", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_shared" });

    let streamCall = 0;
    mockResponsesCreate.mockImplementation(() => {
      const gen = ++streamCall;
      return simpleStream(`resp_${gen}`, "conv_shared", `msg${gen}`);
    });

    const provider = createOpenAIProvider(config);
    const [r1, r2] = await Promise.all([
      provider.send({ messages: [{ role: MessageRole.USER, content: "A" }] }),
      provider.send({ messages: [{ role: MessageRole.USER, content: "B" }] }),
    ]);

    expect(mockConversationsCreate).toHaveBeenCalledTimes(1);
    expect(r1.content).toBeDefined();
    expect(r2.content).toBeDefined();
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
