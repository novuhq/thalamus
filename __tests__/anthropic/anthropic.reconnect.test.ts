import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../../src/anthropic/anthropic.provider.js";
import { MessageRole, type StreamPart } from "../../src/types.js";
import { config } from "./_helpers.js";

const mockCreate = vi.fn();
const mockSseStream = vi.fn();
const mockSend = vi.fn();
const mockList = vi.fn();

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  // biome-ignore lint/complexity/useArrowFunction: must be callable with `new`
  const MockAnthropic = function () {
    return {
      beta: {
        sessions: {
          create: mockCreate,
          retrieve: vi.fn().mockResolvedValue({ status: "running" }),
          events: { stream: mockSseStream, send: mockSend, list: mockList },
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
  AnthropicAws: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

function asyncIter(events: object[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
  };
}

function failingAsyncIter(events: object[], failAfter: number) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (let i = 0; i < failAfter && i < events.length; i++) {
        yield events[i];
      }
      throw new Error("SSE connection dropped");
    },
  };
}

describe("send — resilient observation (auto-reconnect)", () => {
  it("reconnects after SSE drop, fetches missed events, and delivers all events", async () => {
    mockCreate.mockResolvedValue({ id: "sess_rc" });
    mockSend.mockResolvedValue({});

    // First SSE: delivers event 1 and 2, then drops
    mockSseStream.mockResolvedValueOnce(
      failingAsyncIter(
        [
          { type: "session.status_running", id: "evt_1" },
          {
            type: "agent.message",
            id: "evt_2",
            content: [{ type: "text", text: "Hello" }],
          },
        ],
        2,
      ),
    );

    // events.list catches up with missed event 3
    mockList.mockResolvedValueOnce(
      asyncIter([
        { type: "session.status_running", id: "evt_1" },
        {
          type: "agent.message",
          id: "evt_2",
          content: [{ type: "text", text: "Hello" }],
        },
        {
          type: "agent.message",
          id: "evt_3",
          content: [{ type: "text", text: " world" }],
        },
      ]),
    );

    // Second SSE: delivers event 3 again (duplicate) + finish
    mockSseStream.mockResolvedValueOnce(
      asyncIter([
        {
          type: "agent.message",
          id: "evt_3",
          content: [{ type: "text", text: " world" }],
        },
        {
          type: "session.status_idle",
          id: "evt_4",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );

    const parts: StreamPart[] = [];
    const provider = createAnthropicProvider({
      ...config,
      onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
    });
    const response = await provider.send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    expect(response.content).toBe("Hello world");
    expect(response.finishReason).toBe("stop");

    expect(mockSseStream).toHaveBeenCalledTimes(2);
    expect(mockList).toHaveBeenCalledTimes(1);

    const textParts = parts.filter((p) => p.type === "message");
    expect(textParts).toHaveLength(2);
    expect(textParts.map((p) => (p as { text: string }).text)).toEqual([
      "Hello",
      " world",
    ]);
  });

  it("deduplicates events seen in both SSE streams", async () => {
    mockCreate.mockResolvedValue({ id: "sess_dedup" });
    mockSend.mockResolvedValue({});

    mockSseStream.mockResolvedValueOnce(
      failingAsyncIter(
        [
          {
            type: "agent.message",
            id: "evt_1",
            content: [{ type: "text", text: "A" }],
          },
        ],
        1,
      ),
    );

    mockList.mockResolvedValueOnce(
      asyncIter([
        {
          type: "agent.message",
          id: "evt_1",
          content: [{ type: "text", text: "A" }],
        },
      ]),
    );

    // Second SSE re-delivers evt_1 (should be deduped) + new events
    mockSseStream.mockResolvedValueOnce(
      asyncIter([
        {
          type: "agent.message",
          id: "evt_1",
          content: [{ type: "text", text: "A" }],
        },
        {
          type: "agent.message",
          id: "evt_2",
          content: [{ type: "text", text: "B" }],
        },
        {
          type: "session.status_idle",
          id: "evt_3",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );

    const parts: StreamPart[] = [];
    const provider = createAnthropicProvider({
      ...config,
      onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
    });
    const response = await provider.send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    expect(response.content).toBe("AB");

    const textParts = parts.filter((p) => p.type === "message");
    expect(textParts).toHaveLength(2);
    expect(textParts.map((p) => (p as { text: string }).text)).toEqual([
      "A",
      "B",
    ]);
  });

  it("gives up after MAX_RECONNECT_RETRIES and yields error", async () => {
    mockCreate.mockResolvedValue({ id: "sess_fail" });
    mockSend.mockResolvedValue({});

    mockSseStream.mockResolvedValue(failingAsyncIter([], 0));
    mockList.mockRejectedValue(new Error("list failed too"));

    const provider = createAnthropicProvider(config);
    const result = provider.send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    await expect(result).rejects.toThrow();

    // 1 initial + 3 retries = 4 total
    expect(mockSseStream).toHaveBeenCalledTimes(4);
  });
});
