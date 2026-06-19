import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../../src/anthropic/anthropic.provider.js";
import { ThalamusError } from "../../src/errors.js";
import { MessageRole } from "../../src/types.js";
import { config, mockSse } from "./_helpers.js";

const mockCreate = vi.fn();
const mockSseStream = vi.fn();
const mockSend = vi.fn();

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  // biome-ignore lint/complexity/useArrowFunction: must be callable with `new`
  const MockAnthropic = function () {
    return {
      beta: {
        sessions: {
          create: mockCreate,
          events: { stream: mockSseStream, send: mockSend },
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

vi.mock("@anthropic-ai/aws-sdk", () => ({ AnthropicAws: vi.fn() }));

afterEach(() => vi.clearAllMocks());

function idleStop(id: string) {
  return { type: "session.status_idle", id, stop_reason: { type: "end_turn" } };
}

function idleRequiresAction(id: string) {
  return {
    type: "session.status_idle",
    id,
    stop_reason: { type: "requires_action" },
  };
}

/** Streams only auto-start when onSessionEvents is set (see SendResult). */
const autoStartConfig = {
  ...config,
  onSessionEvents: () => ({}),
};

function simpleStream(text: string, idPrefix: string) {
  return mockSse([
    {
      type: "agent.message",
      id: `${idPrefix}_1`,
      content: [{ type: "text", text }],
    },
    idleStop(`${idPrefix}_2`),
  ]);
}

describe("sequential turns (queue)", () => {
  it("serial sends with sessionId both complete", async () => {
    mockSseStream.mockResolvedValue(simpleStream("Continued.", "evt_a"));
    mockSend.mockResolvedValue({});

    const rt = createAnthropicProvider(config);
    const r1 = await rt.send({
      messages: [{ role: MessageRole.USER, content: "A" }],
      sessionId: "sess_1",
    });
    expect(r1.messages).toEqual(["Continued."]);

    mockSseStream.mockResolvedValue(simpleStream("Second.", "evt_b"));

    const r2 = await rt.send({
      messages: [{ role: MessageRole.USER, content: "B" }],
      sessionId: "sess_1",
    });
    expect(r2.messages).toEqual(["Second."]);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("second send waits until first turn completes", async () => {
    const provider = createAnthropicProvider(config);
    mockSend.mockResolvedValue({});

    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((r) => {
      releaseFirst = r;
    });

    let streamGeneration = 0;
    mockSseStream.mockImplementation(() => {
      const generation = ++streamGeneration;
      return {
        [Symbol.asyncIterator]: async function* () {
          if (generation === 1) {
            yield {
              type: "agent.message",
              id: "e1",
              content: [{ type: "text", text: "first" }],
            };
            await holdFirst;
            yield idleStop("e2");
          } else {
            yield {
              type: "agent.message",
              id: "e3",
              content: [{ type: "text", text: "second" }],
            };
            yield idleStop("e4");
          }
        },
      };
    });

    const first = provider.send({
      sessionId: "sess_1",
      messages: [{ role: MessageRole.USER, content: "A" }],
    });
    void first.response;

    await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(mockSseStream).toHaveBeenCalledTimes(1);

    const second = provider.send({
      sessionId: "sess_1",
      messages: [{ role: MessageRole.USER, content: "B" }],
    });
    void second.response;

    releaseFirst();
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1.messages).toEqual(["first"]);
    expect(r2.messages).toEqual(["second"]);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSseStream).toHaveBeenCalledTimes(2);
  });

  it("three concurrent sends maintain FIFO order", async () => {
    const provider = createAnthropicProvider(config);
    mockSend.mockResolvedValue({});
    const order: number[] = [];

    const barriers: Array<() => void> = [];
    let streamGeneration = 0;
    mockSseStream.mockImplementation(() => {
      const gen = ++streamGeneration;
      return {
        [Symbol.asyncIterator]: async function* () {
          order.push(gen);
          const gate = new Promise<void>((r) => barriers.push(r));
          yield {
            type: "agent.message",
            id: `e_${gen}`,
            content: [{ type: "text", text: `msg${gen}` }],
          };
          await gate;
          yield idleStop(`idle_${gen}`);
        },
      };
    });

    const sends = [1, 2, 3].map((n) =>
      provider.send({
        sessionId: "sess_1",
        messages: [{ role: MessageRole.USER, content: `${n}` }],
      }),
    );
    for (const s of sends) void s.response;

    await vi.waitFor(() => expect(mockSseStream).toHaveBeenCalledTimes(1));
    expect(order).toEqual([1]);

    barriers[0]();
    await vi.waitFor(() => expect(mockSseStream).toHaveBeenCalledTimes(2));
    expect(order).toEqual([1, 2]);

    barriers[1]();
    await vi.waitFor(() => expect(mockSseStream).toHaveBeenCalledTimes(3));
    expect(order).toEqual([1, 2, 3]);

    barriers[2]();
    const results = await Promise.all(sends);
    expect(results.map((r) => r.messages.join("\n\n"))).toEqual([
      "msg1",
      "msg2",
      "msg3",
    ]);
  });

  it("different sessions don't block each other", async () => {
    const provider = createAnthropicProvider(config);
    mockSend.mockResolvedValue({});

    let releaseA!: () => void;
    const holdA = new Promise<void>((r) => {
      releaseA = r;
    });

    let streamGeneration = 0;
    mockSseStream.mockImplementation(() => {
      const gen = ++streamGeneration;
      return {
        [Symbol.asyncIterator]: async function* () {
          if (gen === 1) {
            yield {
              type: "agent.message",
              id: "ea",
              content: [{ type: "text", text: "A done" }],
            };
            await holdA;
            yield idleStop("idle_a");
          } else {
            yield {
              type: "agent.message",
              id: "eb",
              content: [{ type: "text", text: "B done" }],
            };
            yield idleStop("idle_b");
          }
        },
      };
    });

    const sendA = provider.send({
      sessionId: "sess_a",
      messages: [{ role: MessageRole.USER, content: "A" }],
    });
    void sendA.response;

    await vi.waitFor(() => expect(mockSseStream).toHaveBeenCalledTimes(1));

    const sendB = provider.send({
      sessionId: "sess_b",
      messages: [{ role: MessageRole.USER, content: "B" }],
    });

    const resultB = await sendB;
    expect(resultB.messages).toEqual(["B done"]);
    expect(mockSseStream).toHaveBeenCalledTimes(2);

    releaseA();
    const resultA = await sendA;
    expect(resultA.messages).toEqual(["A done"]);
  });

  it("toolResults bypass the queue", async () => {
    const provider = createAnthropicProvider(config);
    mockSend.mockResolvedValue({});

    let streamGeneration = 0;
    mockSseStream.mockImplementation(() => {
      const generation = ++streamGeneration;
      return {
        [Symbol.asyncIterator]: async function* () {
          if (generation === 1) {
            yield {
              type: "agent.mcp_tool_use",
              id: "e1",
              name: "web_search",
              mcp_server_name: "test",
              input: {},
              evaluated_permission: "ask",
            };
            yield idleRequiresAction("e2");
          } else if (generation === 2) {
            yield {
              type: "agent.message",
              id: "e3",
              content: [{ type: "text", text: "approved" }],
            };
            yield idleStop("e4");
          } else {
            yield {
              type: "agent.message",
              id: "e5",
              content: [{ type: "text", text: "after" }],
            };
            yield idleStop("e6");
          }
        },
      };
    });

    const first = provider.send({
      sessionId: "sess_1",
      messages: [{ role: MessageRole.USER, content: "search" }],
    });
    expect(await first).toMatchObject({ finishReason: "requires-action" });

    const queued = provider.send({
      sessionId: "sess_1",
      messages: [{ role: MessageRole.USER, content: "follow up" }],
    });
    void queued.response;

    const approval = await provider.send({
      sessionId: "sess_1",
      messages: [],
      toolResults: [{ toolUseId: "e1", content: [], approved: true }],
    });
    expect(approval.finishReason).toBe("stop");

    const queuedResult = await queued;
    expect(queuedResult.messages).toEqual(["after"]);
  });

  it("requires-action holds lock — queued message does not dispatch", async () => {
    const provider = createAnthropicProvider(config);
    mockSend.mockResolvedValue({});

    let streamGeneration = 0;
    mockSseStream.mockImplementation(() => {
      const generation = ++streamGeneration;
      return {
        [Symbol.asyncIterator]: async function* () {
          if (generation === 1) {
            yield {
              type: "agent.mcp_tool_use",
              id: "tool_1",
              name: "web_search",
              mcp_server_name: "test",
              input: {},
              evaluated_permission: "ask",
            };
            yield idleRequiresAction("idle_1");
          } else {
            yield {
              type: "agent.message",
              id: `e_${generation}`,
              content: [{ type: "text", text: "next" }],
            };
            yield idleStop(`idle_${generation}`);
          }
        },
      };
    });

    const first = await provider.send({
      sessionId: "sess_1",
      messages: [{ role: MessageRole.USER, content: "search" }],
    });
    expect(first.finishReason).toBe("requires-action");

    const queued = provider.send({
      sessionId: "sess_1",
      messages: [{ role: MessageRole.USER, content: "follow up" }],
    });
    void queued.response;

    await new Promise((r) => setTimeout(r, 50));
    expect(mockSseStream).toHaveBeenCalledTimes(1);

    // Force-release via toolResults to unblock
    mockSseStream.mockResolvedValue(simpleStream("unblocked", "unblock"));
    await provider.send({
      sessionId: "sess_1",
      messages: [],
      toolResults: [{ toolUseId: "tool_1", content: [], approved: true }],
    });
    await queued;
  });

  it("stream error releases lock — next queued message proceeds", async () => {
    const provider = createAnthropicProvider(config);
    mockSend.mockResolvedValue({});

    let streamGeneration = 0;
    mockSseStream.mockImplementation(() => {
      const generation = ++streamGeneration;
      return {
        [Symbol.asyncIterator]: async function* () {
          if (generation === 1) {
            throw new ThalamusError("simulated fatal", {
              provider: "anthropic",
              isRetryable: false,
            });
          } else {
            yield {
              type: "agent.message",
              id: "e_ok",
              content: [{ type: "text", text: "recovered" }],
            };
            yield idleStop("idle_ok");
          }
        },
      };
    });

    const first = provider.send({
      sessionId: "sess_1",
      messages: [{ role: MessageRole.USER, content: "A" }],
    });
    first.response.catch(() => {});

    await vi.waitFor(() => expect(mockSseStream).toHaveBeenCalledTimes(1));

    const second = provider.send({
      sessionId: "sess_1",
      messages: [{ role: MessageRole.USER, content: "B" }],
    });
    void second.response;

    await expect(first.response).rejects.toThrow();

    const r2 = await second;
    expect(r2.messages).toEqual(["recovered"]);
  });

  it("new session (no sessionId) fires immediately", async () => {
    const provider = createAnthropicProvider(config);
    mockCreate.mockResolvedValue({ id: "sess_new" });
    mockSend.mockResolvedValue({});

    mockSseStream.mockImplementation(() => simpleStream("hello", "new"));

    const result = await provider.send({
      messages: [{ role: MessageRole.USER, content: "hi" }],
    });
    expect(result.messages).toEqual(["hello"]);
  });

  it("bootstrap dedup — two sends without sessionId share same session", async () => {
    mockCreate.mockResolvedValue({ id: "sess_shared" });
    mockSend.mockResolvedValue({});

    let streamGeneration = 0;
    mockSseStream.mockImplementation(() => {
      const gen = ++streamGeneration;
      return simpleStream(`msg${gen}`, `evt_${gen}`);
    });

    const provider = createAnthropicProvider(config);
    const [r1, r2] = await Promise.all([
      provider.send({ messages: [{ role: MessageRole.USER, content: "A" }] }),
      provider.send({ messages: [{ role: MessageRole.USER, content: "B" }] }),
    ]);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(r1.messages).toBeDefined();
    expect(r2.messages).toBeDefined();
  });

  it("emits status-change queued when message is waiting", async () => {
    const onStatusChange = vi.fn();
    const provider = createAnthropicProvider({
      ...autoStartConfig,
      onSessionEvents: () => ({ onStatusChange }),
    });
    mockSend.mockResolvedValue({});

    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((r) => {
      releaseFirst = r;
    });

    let streamGeneration = 0;
    mockSseStream.mockImplementation(() => {
      const generation = ++streamGeneration;
      return {
        [Symbol.asyncIterator]: async function* () {
          if (generation === 1) {
            yield {
              type: "agent.message",
              id: "e1",
              content: [{ type: "text", text: "first" }],
            };
            await holdFirst;
            yield idleStop("e2");
          } else {
            yield {
              type: "agent.message",
              id: "e3",
              content: [{ type: "text", text: "second" }],
            };
            yield idleStop("e4");
          }
        },
      };
    });

    const first = provider.send({
      sessionId: "sess_1",
      messages: [{ role: MessageRole.USER, content: "A" }],
    });
    void first.response;

    await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));

    const second = provider.send({
      sessionId: "sess_1",
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
