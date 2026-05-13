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

describe("createAnthropicProvider", () => {
  it("sets provider = anthropic and runtimeId = agentId", () => {
    const rt = createAnthropicProvider(config);
    expect(rt.provider).toBe("anthropic");
    expect(rt.runtimeId).toBe("agent_abc");
  });
});

describe("stream — new session", () => {
  it("creates a session, yields stream-start + text-delta + finish, resolves response", async () => {
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

    const rt = createAnthropicProvider(config);
    const parts: any[] = [];
    const response = await rt.stream(
      { messages: [{ role: MessageRole.USER, content: "Hi" }] },
      { onPart: (p) => parts.push(p) },
    );

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockSend).toHaveBeenCalledOnce();
    expect(parts.find((p) => p.type === "stream-start")).toMatchObject({
      sessionId: "sess_new",
    });
    expect(parts.find((p) => p.type === "text-delta")).toMatchObject({
      text: "Hello!",
    });
    expect(parts.find((p) => p.type === "finish")).toBeDefined();

    expect(response.content).toBe("Hello!");
    expect(response.sessionId).toBe("sess_new");
    expect(response.finishReason).toBe("stop");
  });
});

describe("stream — resume session", () => {
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
    await rt.stream({
      messages: [{ role: MessageRole.USER, content: "next" }],
      sessionId: "sess_existing",
    });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSseStream).toHaveBeenCalledWith("sess_existing");
  });
});
