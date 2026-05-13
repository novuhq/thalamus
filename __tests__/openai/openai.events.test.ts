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
  return { default: MockOpenAI, APIError: actual.APIError };
});

afterEach(() => vi.clearAllMocks());

describe("thinking / reasoning events", () => {
  it("emits thinking part on response.reasoning_summary_text.delta", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_think" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_t", conversation: { id: "conv_think" } },
        },
        {
          type: "response.reasoning_summary_text.delta",
          delta: "Let me think...",
          item_id: "item_1",
          output_index: 0,
          sequence_number: 1,
        },
        {
          type: "response.completed",
          response: { id: "resp_t", output_text: "", usage: {} },
        },
      ]),
    );

    const parts: any[] = [];
    await createOpenAIProvider(config).stream(
      { messages: [{ role: MessageRole.USER, content: "think" }] },
      { onPart: (p) => parts.push(p) },
    );

    expect(parts.find((p) => p.type === "thinking")).toMatchObject({
      type: "thinking",
      text: "Let me think...",
    });
  });
});

describe("response lifecycle events", () => {
  it("emits status-change running on response.in_progress", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_ip" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_ip", conversation: { id: "conv_ip" } },
        },
        { type: "response.in_progress", response: { id: "resp_ip" } },
        {
          type: "response.completed",
          response: { id: "resp_ip", output_text: "ok", usage: {} },
        },
      ]),
    );

    const parts: any[] = [];
    await createOpenAIProvider(config).stream(
      { messages: [{ role: MessageRole.USER, content: "x" }] },
      { onPart: (p) => parts.push(p) },
    );

    expect(parts.find((p) => p.type === "status-change")).toMatchObject({
      status: "running",
    });
  });

  it("sets finishReason to error on response.failed", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_fail" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_f", conversation: { id: "conv_fail" } },
        },
        {
          type: "response.failed",
          response: { id: "resp_f", error: { message: "Something broke" } },
        },
      ]),
    );

    const parts: any[] = [];
    try {
      await createOpenAIProvider(config).stream(
        { messages: [{ role: MessageRole.USER, content: "x" }] },
        { onPart: (p) => parts.push(p) },
      );
    } catch (_) {}

    const errPart = parts.find((p) => p.type === "error");
    expect(errPart).toBeDefined();
    expect((errPart as any).error.message).toBe("Something broke");
  });

  it("sets finishReason to length on response.incomplete", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_inc" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_i", conversation: { id: "conv_inc" } },
        },
        { type: "response.output_text.delta", delta: "partial..." },
        { type: "response.incomplete", response: { id: "resp_i" } },
        {
          type: "response.completed",
          response: { id: "resp_i", output_text: "partial...", usage: {} },
        },
      ]),
    );

    const response = await createOpenAIProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "x" }],
    });

    expect(response.finishReason).toBe("length");
  });

  it("emits provider-event for unknown event types", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_unk" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_u", conversation: { id: "conv_unk" } },
        },
        { type: "response.some_future_event", data: { foo: "bar" } },
        {
          type: "response.completed",
          response: { id: "resp_u", output_text: "", usage: {} },
        },
      ]),
    );

    const parts: any[] = [];
    await createOpenAIProvider(config).stream(
      { messages: [{ role: MessageRole.USER, content: "x" }] },
      { onPart: (p) => parts.push(p) },
    );

    const providerEvent = parts.find((p) => p.type === "provider-event") as any;
    expect(providerEvent).toBeDefined();
    expect(providerEvent.provider).toBe("openai");
    expect(providerEvent.event).toBe("response.some_future_event");
  });
});
