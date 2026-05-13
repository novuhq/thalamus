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
  return { default: MockAnthropic, APIError: actual.APIError };
});

vi.mock("@anthropic-ai/aws-sdk", () => ({
  AnthropicAws: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

describe("tool results / approval flow", () => {
  it("sends user.tool_confirmation when toolResults has approved=true", async () => {
    mockSseStream.mockReturnValue(
      mockSse([
        {
          type: "agent.message",
          id: "evt_1",
          content: [{ type: "text", text: "Done!" }],
        },
        {
          type: "session.status_idle",
          id: "evt_2",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );
    mockSend.mockResolvedValue({});

    const provider = createAnthropicProvider(config);
    await provider.stream({
      messages: [{ role: MessageRole.USER, content: "" }],
      sessionId: "sess_appr",
      toolResults: [{ toolUseId: "tu_789", approved: true }],
    });

    expect(mockSend).toHaveBeenCalledWith("sess_appr", {
      events: [
        {
          type: "user.tool_confirmation",
          tool_use_id: "tu_789",
          result: "allow",
        },
      ],
    });
  });

  it("sends user.tool_confirmation with deny when approved=false", async () => {
    mockSseStream.mockReturnValue(
      mockSse([
        {
          type: "session.status_idle",
          id: "evt_1",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );
    mockSend.mockResolvedValue({});

    const provider = createAnthropicProvider(config);
    await provider.stream({
      messages: [{ role: MessageRole.USER, content: "" }],
      sessionId: "sess_deny",
      toolResults: [{ toolUseId: "tu_789", approved: false }],
    });

    expect(mockSend).toHaveBeenCalledWith("sess_deny", {
      events: [
        {
          type: "user.tool_confirmation",
          tool_use_id: "tu_789",
          result: "deny",
        },
      ],
    });
  });
});
