import { APIUserAbortError } from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../../src/anthropic/anthropic.provider.js";
import { AbortedError } from "../../src/errors.js";
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

vi.mock("@anthropic-ai/aws-sdk", () => ({
  AnthropicAws: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

describe("stream — abort signal", () => {
  it("yields AbortedError when the signal is aborted during SSE streaming", async () => {
    mockCreate.mockResolvedValue({ id: "sess_abort" });
    mockSseStream.mockRejectedValue(new APIUserAbortError());
    mockSend.mockResolvedValue({});

    const rt = createAnthropicProvider(config);
    const controller = new AbortController();
    controller.abort();

    const result = rt.stream({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
      abortSignal: controller.signal,
    });

    await expect(result).rejects.toThrow(AbortedError);
    await expect(result).rejects.toMatchObject({
      name: "AbortedError",
      isRetryable: false,
      provider: "anthropic",
    });
  });

  it("passes abort signal to events.stream and events.send", async () => {
    mockCreate.mockResolvedValue({ id: "sess_sig" });
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "agent.message",
          id: "evt_1",
          content: [{ type: "text", text: "ok" }],
        },
        {
          type: "session.status_idle",
          id: "evt_2",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );
    mockSend.mockResolvedValue({});

    const controller = new AbortController();
    const rt = createAnthropicProvider(config);
    await rt.stream({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
      abortSignal: controller.signal,
    });

    expect(mockSseStream).toHaveBeenCalledWith(
      "sess_sig",
      undefined,
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(mockSend).toHaveBeenCalledWith(
      "sess_sig",
      expect.any(Object),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
