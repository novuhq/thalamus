import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../../src/anthropic/anthropic.provider.js";
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

describe("sequential turns (queue)", () => {
  it("serial sends with sessionId both complete", async () => {
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "agent.message",
          id: "evt_1",
          content: [{ type: "text", text: "Continued." }],
        },
        {
          type: "session.status_idle",
          id: "evt_2",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );
    mockSend.mockResolvedValue({});

    const rt = createAnthropicProvider(config);
    const r1 = await rt.send({
      messages: [{ role: MessageRole.USER, content: "A" }],
      sessionId: "sess_1",
    });
    expect(r1.content).toBe("Continued.");

    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "agent.message",
          id: "evt_3",
          content: [{ type: "text", text: "Second." }],
        },
        {
          type: "session.status_idle",
          id: "evt_4",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );

    const r2 = await rt.send({
      messages: [{ role: MessageRole.USER, content: "B" }],
      sessionId: "sess_1",
    });
    expect(r2.content).toBe("Second.");
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

    expect(r1.content).toBe("first");
    expect(r2.content).toBe("second");
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSseStream).toHaveBeenCalledTimes(2);
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
      toolResults: [{ toolUseId: "e1", approved: true }],
    });
    expect(approval.finishReason).toBe("stop");

    const queuedResult = await queued;
    expect(queuedResult.content).toBe("after");
  });

  it("new session (no sessionId) fires immediately", async () => {
    const provider = createAnthropicProvider(config);
    mockCreate.mockResolvedValue({ id: "sess_new" });
    mockSend.mockResolvedValue({});

    mockSseStream.mockImplementation(() => ({
      [Symbol.asyncIterator]: async function* () {
        yield {
          type: "agent.message",
          id: "e1",
          content: [{ type: "text", text: "hello" }],
        };
        yield idleStop("e2");
      },
    }));

    const result = await provider.send({
      messages: [{ role: MessageRole.USER, content: "hi" }],
    });
    expect(result.content).toBe("hello");
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
