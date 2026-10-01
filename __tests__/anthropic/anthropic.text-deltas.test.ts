import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../../src/anthropic/anthropic.provider.js";
import { cloudflare } from "../../src/durable/cloudflare.js";
import type { DurabilityBackend } from "../../src/durable/types.js";
import { MessageRole, type StreamPart } from "../../src/types.js";
import { config, mockSse } from "./_helpers.js";

/*
 * Managed Agents `event_deltas` previews (always requested).
 *
 * Wire facts (platform.claude.com/docs/en/managed-agents/events-and-streaming#event-deltas):
 * - `event_start` / `event_delta` carry NO top-level `id`; the only id is the
 *   previewed event's (`event.id` / `event_id`), equal to the buffered `agent.message.id`.
 * - Deltas are incremental and best-effort (a prefix may arrive, then nothing).
 * - A model request ended early (interrupt / error) produces no `agent.message`;
 *   `span.model_request_end` closes the preview.
 * - Previews never appear in `events.list` history, so they must not be deduped
 *   by id or used as resume checkpoints.
 */

const mockCreate = vi.fn();
const mockSseStream = vi.fn();
const mockSend = vi.fn();
const mockList = vi.fn();
const mockFetch = vi.fn<typeof globalThis.fetch>();

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  // biome-ignore lint/complexity/useArrowFunction: must be callable with `new`
  const MockAnthropic = function () {
    return {
      baseURL: "https://api.anthropic.com",
      apiKey: "sk-test",
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const start = (id: string, type = "agent.message") => ({
  type: "event_start",
  event: { type, id },
});
const delta = (eventId: string, text: string, index = 0) => ({
  type: "event_delta",
  event_id: eventId,
  delta: { type: "content_delta", index, content: { type: "text", text } },
});
const message = (id: string, ...texts: string[]) => ({
  type: "agent.message",
  id,
  content: texts.map((text) => ({ type: "text", text })),
});
const spanStart = (id: string) => ({ type: "span.model_request_start", id });
const spanEnd = (id: string) => ({
  type: "span.model_request_end",
  id,
  model_usage: { input_tokens: 1, output_tokens: 1 },
});
const idle = (id: string) => ({
  type: "session.status_idle",
  id,
  stop_reason: { type: "end_turn" },
});

async function run(events: object[]) {
  mockCreate.mockResolvedValue({ id: "sess_deltas" });
  mockSseStream.mockResolvedValue(mockSse(events));
  mockSend.mockResolvedValue({});

  const parts: StreamPart[] = [];
  let error: unknown;
  let response: Awaited<
    ReturnType<ReturnType<typeof createAnthropicProvider>["send"]>
  > | null = null;
  try {
    response = await createAnthropicProvider({
      ...config,
      onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
    }).send({ messages: [{ role: MessageRole.USER, content: "hi" }] });
  } catch (err) {
    error = err;
  }

  const textParts = parts.filter(
    (p) =>
      p.type === "text-start" ||
      p.type === "text-delta" ||
      p.type === "message",
  );
  return { parts, textParts, response, error };
}

describe("anthropic text deltas — request", () => {
  it("adds the event_deltas query to the edge observer stream URL", async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockCreate.mockResolvedValue({ id: "sess_edge" });
    mockSend.mockResolvedValue({});
    mockFetch.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/enqueue")) {
        return new Response(JSON.stringify({ status: "active" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(null, { status: 204 });
    });

    const observedStreamUrl = async () => {
      mockFetch.mockClear();
      await createAnthropicProvider({
        ...config,
        durable: cloudflare({
          url: "https://worker.example.com",
          webhook: { url: "https://app.example/webhook", secret: "s" },
        }),
      }).send({ messages: [{ role: MessageRole.USER, content: "hi" }] });
      const call = mockFetch.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].endsWith("/observe"),
      );
      return JSON.parse(call?.[1]?.body as string).streamUrl as string;
    };

    expect(await observedStreamUrl()).toBe(
      "https://api.anthropic.com/v1/sessions/sess_edge/events/stream?event_deltas%5B%5D=agent.message",
    );
  });
});

describe("anthropic text deltas — streaming", () => {
  it("streams a realistic two-message turn: ordered deltas, multi-block content, a shed preview, each correlated with its final message", async () => {
    const { textParts, response, error } = await run([
      { type: "session.status_running", id: "evt_run" },
      spanStart("span_1"),
      start("sevt_a"),
      delta("sevt_a", "Let me "),
      delta("sevt_a", "check "),
      delta("sevt_a", "that."),
      delta("sevt_a", " Second block.", 1),
      message("sevt_a", "Let me check that.", " Second block."),
      spanEnd("span_1_end"),
      {
        type: "agent.tool_use",
        id: "tu_1",
        name: "bash",
        input: { command: "ls" },
      },
      { type: "agent.tool_result", id: "tr_1", tool_use_id: "tu_1" },
      spanStart("span_2"),
      start("sevt_b"),
      // Shed under load: only a prefix arrives, then the buffered event.
      delta("sevt_b", "Found 3 "),
      message("sevt_b", "Found 3 files: a.ts, b.ts, c.ts"),
      spanEnd("span_2_end"),
      idle("evt_idle"),
    ]);

    expect(error).toBeUndefined();
    expect(textParts).toEqual([
      { type: "text-start", messageId: "sevt_a" },
      { type: "text-delta", messageId: "sevt_a", text: "Let me " },
      { type: "text-delta", messageId: "sevt_a", text: "check " },
      { type: "text-delta", messageId: "sevt_a", text: "that." },
      { type: "text-delta", messageId: "sevt_a", text: " Second block." },
      {
        type: "message",
        messageId: "sevt_a",
        text: "Let me check that. Second block.",
      },
      { type: "text-start", messageId: "sevt_b" },
      { type: "text-delta", messageId: "sevt_b", text: "Found 3 " },
      {
        type: "message",
        messageId: "sevt_b",
        text: "Found 3 files: a.ts, b.ts, c.ts",
      },
    ]);

    // Preview text never becomes durable output.
    expect(response?.messages).toEqual([
      "Let me check that. Second block.",
      "Found 3 files: a.ts, b.ts, c.ts",
    ]);
  });

  it("closes an interrupted preview without a message: partial text never reaches the response", async () => {
    const { textParts, response, error } = await run([
      spanStart("span_1"),
      start("sevt_cut"),
      delta("sevt_cut", "I was about to"),
      // user.interrupt: the model request ends early, no buffered agent.message.
      spanEnd("span_1_end"),
      idle("evt_idle"),
    ]);

    expect(error).toBeUndefined();
    expect(textParts).toEqual([
      { type: "text-start", messageId: "sevt_cut" },
      { type: "text-delta", messageId: "sevt_cut", text: "I was about to" },
    ]);
    expect(response?.messages).toEqual([]);
  });

  it("ignores thinking previews (start-only) instead of leaking them", async () => {
    const { parts } = await run([
      start("sevt_think", "agent.thinking"),
      { type: "agent.thinking", id: "sevt_think" },
      idle("evt_idle"),
    ]);

    expect(parts.map((p) => p.type)).toEqual([
      "run-start",
      "thinking",
      "status-change",
      "finish",
    ]);
  });
});

describe("anthropic text deltas — durability", () => {
  it("never checkpoints or dedups id-less preview frames", async () => {
    const save = vi.fn<DurabilityBackend["save"]>(async () => {});
    const backend: DurabilityBackend = {
      save,
      remove: vi.fn(async () => {}),
      getActive: vi.fn(async () => []),
    };
    mockCreate.mockResolvedValue({ id: "sess_cp" });
    mockSseStream.mockResolvedValue(
      mockSse([
        start("sevt_1"),
        delta("sevt_1", "a"),
        delta("sevt_1", "b"),
        message("sevt_1", "ab"),
        start("sevt_2"),
        delta("sevt_2", "c"),
        message("sevt_2", "c"),
        idle("evt_idle"),
      ]),
    );
    mockSend.mockResolvedValue({});

    const parts: StreamPart[] = [];
    await createAnthropicProvider({
      ...config,
      durable: backend,
      onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
    }).send({ messages: [{ role: MessageRole.USER, content: "hi" }] });

    // Every preview frame survives (no id-based dedup across id-less frames).
    expect(
      parts.filter((p) => p.type === "text-delta").map((p) => p.text),
    ).toEqual(["a", "b", "c"]);
    // Only persisted events (resumable via events.list) become checkpoints.
    const checkpointIds = save.mock.calls.map(([cp]) => cp.lastEventId);
    expect(checkpointIds).toEqual(["sevt_1", "sevt_2", "evt_idle"]);
  });
});
