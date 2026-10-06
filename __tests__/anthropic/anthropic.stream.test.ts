import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../../src/anthropic/anthropic.provider.js";
import {
  mapEvent,
  ResponseAccumulator,
} from "../../src/anthropic/anthropic-parser.js";
import { MessageRole } from "../../src/types.js";
import { config, emptyHistory, mockSse } from "./_helpers.js";

const mockCreate = vi.fn();
const mockSseStream = vi.fn();
const mockSend = vi.fn();
const mockList = vi.fn(emptyHistory);

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  // biome-ignore lint/complexity/useArrowFunction: must be callable with `new`
  const MockAnthropic = function () {
    return {
      beta: {
        sessions: {
          create: mockCreate,
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

describe("createAnthropicProvider", () => {
  it("sets provider = anthropic and runtimeId = agentId", () => {
    const rt = createAnthropicProvider(config);
    expect(rt.provider).toBe("anthropic");
    expect(rt.runtimeId).toBe("agent_abc");
  });
});

describe("stream — new session", () => {
  it("creates a session, yields run-start + message + finish, resolves response", async () => {
    mockCreate.mockResolvedValue({ id: "sess_new" });
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "agent.message",
          id: "evt_1",
          content: [{ type: "text", text: "Hello!" }],
        },
        {
          type: "session.status_idle",
          id: "evt_2",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );
    mockSend.mockResolvedValue({});

    const parts: any[] = [];
    const rt = createAnthropicProvider({
      ...config,
      onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
    });
    const response = await rt.send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        initial_events: [
          { type: "user.message", content: [{ type: "text", text: "Hi" }] },
        ],
      }),
    );
    expect(mockSend).not.toHaveBeenCalled();
    expect(parts.find((p) => p.type === "run-start")).toMatchObject({
      sessionId: "sess_new",
    });
    expect(parts.find((p) => p.type === "message")).toMatchObject({
      text: "Hello!",
    });
    expect(parts.find((p) => p.type === "finish")).toBeDefined();

    expect(response.messages).toEqual(["Hello!"]);
    expect(response.sessionId).toBe("sess_new");
    expect(response.finishReason).toBe("stop");
  });

  it("recovers a turn that ran before the stream opened from history", async () => {
    mockCreate.mockResolvedValue({ id: "sess_fast" });
    const neverYields = {
      controller: new AbortController(),
      [Symbol.asyncIterator]: async function* () {
        await new Promise(() => {});
      },
    };
    mockSseStream.mockResolvedValue(neverYields);
    mockList.mockResolvedValue(
      mockSse([
        { type: "user.message", id: "evt_0", content: [] },
        { type: "session.status_running", id: "evt_1" },
        {
          type: "agent.message",
          id: "evt_2",
          content: [{ type: "text", text: "Done already." }],
        },
        {
          type: "session.status_idle",
          id: "evt_3",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );

    const rt = createAnthropicProvider(config);
    const response = await rt.send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    expect(mockList.mock.calls[0][0]).toBe("sess_fast");
    expect(response.messages).toEqual(["Done already."]);
    expect(response.finishReason).toBe("stop");
  });

  it("retries the first history catch-up instead of tailing a stream that already went quiet", async () => {
    mockCreate.mockResolvedValue({ id: "sess_flaky" });
    const quietStream = () => ({
      controller: new AbortController(),
      [Symbol.asyncIterator]: async function* () {
        await new Promise(() => {});
      },
    });
    const first = quietStream();
    const second = quietStream();
    mockSseStream.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    mockList
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(
        mockSse([
          {
            type: "agent.message",
            id: "evt_1",
            content: [{ type: "text", text: "Done already." }],
          },
          {
            type: "session.status_idle",
            id: "evt_2",
            stop_reason: { type: "end_turn" },
          },
        ]),
      );

    const response = await createAnthropicProvider(config).send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    expect(response.messages).toEqual(["Done already."]);
    expect(mockSseStream).toHaveBeenCalledTimes(2);
    expect(first.controller.signal.aborted).toBe(true);
    expect(second.controller.signal.aborted).toBe(true);
  });

  it("seeds the turn's messages after initial_events from providerOptions", async () => {
    mockCreate.mockResolvedValue({ id: "sess_po" });
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "session.status_idle",
          id: "evt_1",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );
    const callerEvent = { type: "user.define_outcome", description: "ship it" };

    await createAnthropicProvider(config).send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
      providerOptions: { initial_events: [callerEvent] },
    });

    expect(mockCreate.mock.calls[0][0].initial_events).toEqual([
      callerEvent,
      { type: "user.message", content: [{ type: "text", text: "Hi" }] },
    ]);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockList).toHaveBeenCalled();
  });

  it("surfaces a session error that happened before the stream opened", async () => {
    mockCreate.mockResolvedValue({ id: "sess_err" });
    mockSseStream.mockResolvedValue(mockSse([]));
    mockList.mockResolvedValue(
      mockSse([
        {
          type: "session.error",
          id: "evt_1",
          error: { type: "billing_error", message: "Credit balance too low" },
        },
      ]),
    );

    const rt = createAnthropicProvider(config);
    await expect(
      rt.send({ messages: [{ role: MessageRole.USER, content: "Hi" }] }),
    ).rejects.toThrow("Credit balance too low");
  });
});

describe("parser — session.status_running", () => {
  it("yields run-start before status-change running", () => {
    const parts = [
      ...mapEvent(
        {
          type: "session.status_running",
          id: "evt_running",
          processed_at: "2024-01-01T00:00:00Z",
        } as any,
        new ResponseAccumulator(),
      ),
    ];

    expect(parts).toEqual([
      { type: "run-start" },
      { type: "status-change", status: "running" },
    ]);
  });
});

describe("send — resume session", () => {
  it("skips session creation when sessionId is provided", async () => {
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
    await rt.send({
      messages: [{ role: MessageRole.USER, content: "next" }],
      sessionId: "sess_existing",
    });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSseStream).toHaveBeenCalledWith(
      "sess_existing",
      { event_deltas: ["agent.message"] },
      expect.objectContaining({}),
    );
  });
});
