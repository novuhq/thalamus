import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../../src/anthropic/anthropic.provider.js";
import type {
  DurabilityBackend,
  SessionCheckpoint,
} from "../../src/durable/types.js";
import type { StreamPart } from "../../src/types.js";
import { config } from "./_helpers.js";

function mockBackend(): DurabilityBackend {
  const sessions = new Map<string, SessionCheckpoint>();
  return {
    save: vi.fn(async (cp) => {
      sessions.set(cp.sessionId, cp);
    }),
    remove: vi.fn(async (id) => {
      sessions.delete(id);
    }),
    getActive: vi.fn(async () => [...sessions.values()]),
  };
}

const mockCreate = vi.fn();
const mockSseStream = vi.fn();
const mockSend = vi.fn();
const mockList = vi.fn();
const mockRetrieve = vi.fn();

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  // biome-ignore lint/complexity/useArrowFunction: must be callable with `new`
  const MockAnthropic = function () {
    return {
      beta: {
        sessions: {
          create: mockCreate,
          retrieve: mockRetrieve,
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

describe("durable recovery — Anthropic", () => {
  it("checkpoints events during normal send", async () => {
    mockCreate.mockResolvedValue({ id: "sess_ckpt" });
    mockSend.mockResolvedValue({});

    mockSseStream.mockResolvedValueOnce(
      asyncIter([
        {
          type: "agent.message",
          id: "evt_1",
          content: [{ type: "text", text: "Hello" }],
        },
        {
          type: "session.status_idle",
          id: "evt_2",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );

    const durable = mockBackend();

    const provider = createAnthropicProvider({
      ...config,
      durable,
    });

    await provider.send({
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(durable.save).toHaveBeenCalledTimes(2);
    expect(durable.save).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess_ckpt",
        provider: "anthropic",
        lastEventId: "evt_1",
      }),
    );
    expect(durable.save).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess_ckpt",
        provider: "anthropic",
        lastEventId: "evt_2",
      }),
    );
    expect(durable.remove).toHaveBeenCalledWith("sess_ckpt");

    const active = await durable.getActive();
    expect(active).toEqual([]);
  });

  it("recovers a running session after simulated crash", async () => {
    const durable = mockBackend();

    await durable.save({
      sessionId: "sess_crash",
      provider: "anthropic",
      lastEventId: "evt_2",
      createdAt: 1000,
    });

    mockRetrieve.mockResolvedValue({ status: "running" });

    // events.list returns all historical events (evt_1, evt_2 already seen + evt_3 missed)
    mockList.mockResolvedValueOnce(
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
          type: "agent.message",
          id: "evt_3",
          content: [{ type: "text", text: "C" }],
        },
      ]),
    );

    // SSE stream continues with evt_3 (overlap — deduped) + evt_4 (finish)
    mockSseStream.mockResolvedValueOnce(
      asyncIter([
        {
          type: "agent.message",
          id: "evt_3",
          content: [{ type: "text", text: "C" }],
        },
        {
          type: "session.status_idle",
          id: "evt_4",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );

    const parts: StreamPart[] = [];
    createAnthropicProvider({
      ...config,
      durable,
      onSessionEvents: (ctx) => {
        expect(ctx.sessionId).toBe("sess_crash");
        return { onPart: (p) => parts.push(p) };
      },
    });

    // Recovery is fire-and-forget — wait for it to complete
    await vi.waitFor(
      () => {
        expect(parts.some((p) => p.type === "finish")).toBe(true);
      },
      { timeout: 2000 },
    );

    const textParts = parts.filter((p) => p.type === "text-delta");
    expect(textParts.map((p) => (p as { text: string }).text)).toEqual(["C"]);

    const active = await durable.getActive();
    expect(active).toEqual([]);
  });

  it("recovers an idle (finished) session — delivers missed events and cleans up", async () => {
    const durable = mockBackend();

    await durable.save({
      sessionId: "sess_done",
      provider: "anthropic",
      lastEventId: "evt_1",
      createdAt: 1000,
    });

    mockRetrieve.mockResolvedValue({ status: "idle" });

    mockList.mockResolvedValueOnce(
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
    createAnthropicProvider({
      ...config,
      durable,
      onSessionEvents: (_ctx) => ({
        onPart: (p) => parts.push(p),
      }),
    });

    await vi.waitFor(
      () => {
        expect(parts.some((p) => p.type === "finish")).toBe(true);
      },
      { timeout: 2000 },
    );

    const textParts = parts.filter((p) => p.type === "text-delta");
    expect(textParts.map((p) => (p as { text: string }).text)).toEqual(["B"]);

    const active = await durable.getActive();
    expect(active).toEqual([]);
  });

  it("cleans up expired/terminated sessions without firing callbacks", async () => {
    const durable = mockBackend();

    await durable.save({
      sessionId: "sess_expired",
      provider: "anthropic",
      lastEventId: "evt_5",
      createdAt: 1000,
    });

    mockRetrieve.mockResolvedValue({ status: "expired" });

    const callbackFn = vi.fn();
    createAnthropicProvider({
      ...config,
      durable,
      onSessionEvents: () => ({ onPart: callbackFn }),
    });

    // Give recovery time to run
    await new Promise((r) => setTimeout(r, 100));

    expect(callbackFn).not.toHaveBeenCalled();
    const active = await durable.getActive();
    expect(active).toEqual([]);
  });

  it("does not recover if durable is set but onSessionEvents is not", async () => {
    const durable = mockBackend();

    await durable.save({
      sessionId: "sess_no_cb",
      provider: "anthropic",
      lastEventId: "evt_1",
      createdAt: 1000,
    });

    createAnthropicProvider({
      ...config,
      durable,
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(durable.getActive).not.toHaveBeenCalled();
  });

  it("persists runId on every checkpoint and replays it on recovery", async () => {
    mockCreate.mockResolvedValue({ id: "sess_run" });
    mockSend.mockResolvedValue({});
    mockSseStream.mockResolvedValueOnce(
      asyncIter([
        {
          type: "agent.message",
          id: "evt_1",
          content: [{ type: "text", text: "hi" }],
        },
        {
          type: "session.status_idle",
          id: "evt_2",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );

    const durable = mockBackend();
    const provider = createAnthropicProvider({ ...config, durable });

    const result = provider.send({
      messages: [{ role: "user", content: "Hi" }],
    });
    await result;

    const saves = (durable.save as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as SessionCheckpoint,
    );
    expect(saves.length).toBeGreaterThan(0);
    for (const cp of saves) {
      expect(cp.runId).toBe(result.runId);
    }
  });

  it("reuses runId from checkpoint when recovering a session", async () => {
    const durable = mockBackend();
    await durable.save({
      sessionId: "sess_resume",
      provider: "anthropic",
      lastEventId: "evt_1",
      createdAt: 1000,
      runId: "run_persisted_123",
    });

    mockRetrieve.mockResolvedValue({ status: "idle" });
    mockList.mockResolvedValueOnce(
      asyncIter([
        {
          type: "agent.message",
          id: "evt_1",
          content: [{ type: "text", text: "A" }],
        },
        {
          type: "session.status_idle",
          id: "evt_2",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );

    const factory = vi.fn().mockReturnValue({});
    createAnthropicProvider({
      ...config,
      durable,
      onSessionEvents: factory,
    });

    await vi.waitFor(
      () => {
        expect(factory).toHaveBeenCalled();
      },
      { timeout: 2000 },
    );

    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess_resume",
        runId: "run_persisted_123",
        turnId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        metadata: {},
      }),
    );
  });
});
