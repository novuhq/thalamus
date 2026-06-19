import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAIProvider } from "../../src/openai/openai.provider.js";
import { MessageRole, type StreamPart } from "../../src/types.js";
import { config } from "./_helpers.js";

const mockResponsesCreate = vi.fn();
const mockResponsesRetrieve = vi.fn();
const mockConversationsCreate = vi.fn();

vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  // biome-ignore lint/complexity/useArrowFunction: must be callable with `new`
  const MockOpenAI = function () {
    return {
      responses: {
        create: mockResponsesCreate,
        retrieve: mockResponsesRetrieve,
      },
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
      throw new Error("Stream connection dropped");
    },
  };
}

describe("send — resilient observation (auto-reconnect)", () => {
  it("reconnects after stream drop and delivers all events via resumeObservation", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_rc" });

    // Initial stream: delivers response.created + text delta, then drops
    mockResponsesCreate.mockReturnValueOnce(
      failingAsyncIter(
        [
          {
            type: "response.created",
            sequence_number: 0,
            response: { id: "resp_1", conversation: { id: "conv_rc" } },
          },
          {
            type: "response.output_text.delta",
            sequence_number: 1,
            delta: "Hello",
          },
        ],
        2,
      ),
    );

    // Resume stream: delivers remaining events
    mockResponsesRetrieve.mockReturnValueOnce(
      asyncIter([
        {
          type: "response.output_text.delta",
          sequence_number: 2,
          delta: " world",
        },
        {
          type: "response.completed",
          sequence_number: 3,
          response: {
            id: "resp_1",
            output_text: "Hello world",
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15,
            },
          },
        },
      ]),
    );

    const parts: StreamPart[] = [];
    const provider = createOpenAIProvider({
      ...config,
      onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
    });
    const response = await provider.send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    expect(response.messages).toEqual(["Hello world"]);

    expect(mockResponsesCreate).toHaveBeenCalledTimes(1);
    expect(mockResponsesRetrieve).toHaveBeenCalledTimes(1);
    expect(mockResponsesRetrieve).toHaveBeenCalledWith(
      "resp_1",
      expect.objectContaining({ stream: true, starting_after: 1 }),
      expect.any(Object),
    );

    const textParts = parts.filter((p) => p.type === "text-delta");
    expect(textParts).toHaveLength(2);
    expect(textParts.map((p) => (p as { text: string }).text)).toEqual([
      "Hello",
      " world",
    ]);
  });

  it("deduplicates events by sequence_number on reconnect", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_dedup" });

    mockResponsesCreate.mockReturnValueOnce(
      failingAsyncIter(
        [
          {
            type: "response.created",
            sequence_number: 0,
            response: { id: "resp_2", conversation: { id: "conv_dedup" } },
          },
          {
            type: "response.output_text.delta",
            sequence_number: 1,
            delta: "A",
          },
        ],
        2,
      ),
    );

    // Resume re-delivers sequence 1 (should be deduped) + new events
    mockResponsesRetrieve.mockReturnValueOnce(
      asyncIter([
        {
          type: "response.output_text.delta",
          sequence_number: 1,
          delta: "A",
        },
        {
          type: "response.output_text.delta",
          sequence_number: 2,
          delta: "B",
        },
        {
          type: "response.completed",
          sequence_number: 3,
          response: {
            id: "resp_2",
            output_text: "AB",
            usage: {
              input_tokens: 10,
              output_tokens: 2,
              total_tokens: 12,
            },
          },
        },
      ]),
    );

    const parts: StreamPart[] = [];
    const provider = createOpenAIProvider({
      ...config,
      onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
    });
    const response = await provider.send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    expect(response.messages).toEqual(["AB"]);

    const textParts = parts.filter((p) => p.type === "text-delta");
    expect(textParts).toHaveLength(2);
    expect(textParts.map((p) => (p as { text: string }).text)).toEqual([
      "A",
      "B",
    ]);
  });

  it("gives up after MAX_RECONNECT_RETRIES and yields error", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_fail" });

    // Initial stream delivers response.created then drops
    mockResponsesCreate.mockReturnValueOnce(
      failingAsyncIter(
        [
          {
            type: "response.created",
            sequence_number: 0,
            response: { id: "resp_fail", conversation: { id: "conv_fail" } },
          },
        ],
        1,
      ),
    );

    // All retries also fail
    mockResponsesRetrieve.mockRejectedValue(
      new Error("Stream connection dropped"),
    );

    const provider = createOpenAIProvider(config);
    const result = provider.send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    await expect(result).rejects.toThrow();

    expect(mockResponsesCreate).toHaveBeenCalledTimes(1);
    // 3 retries via retrieve
    expect(mockResponsesRetrieve).toHaveBeenCalledTimes(3);
  });
});
