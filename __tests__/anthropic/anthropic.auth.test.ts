import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../../src/anthropic/anthropic.provider.js";
import { MessageRole } from "../../src/types.js";
import { awsConfig, mockSse } from "./_helpers.js";

const mockCreate = vi.fn();
const mockSseStream = vi.fn();
const mockSend = vi.fn();
const mockAnthropicAws = vi.hoisted(() => vi.fn());

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
  AnthropicAws: mockAnthropicAws,
}));

mockAnthropicAws.mockImplementation(function (
  this: any,
  config: Record<string, unknown>,
) {
  return {
    beta: {
      sessions: {
        create: mockCreate,
        events: { stream: mockSseStream, send: mockSend },
      },
      vaults: { create: vi.fn(), retrieve: vi.fn() },
    },
    _awsConfig: config,
  };
});

afterEach(() => vi.clearAllMocks());

describe("AWS auth variant", () => {
  it("creates provider with awsRegion config", () => {
    const rt = createAnthropicProvider(awsConfig);
    expect(rt.provider).toBe("anthropic");
    expect(rt.runtimeId).toBe("agent_abc");
  });

  it("streams successfully via AnthropicAws client", async () => {
    mockCreate.mockResolvedValue({ id: "sess_aws" });
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "agent.message",
          id: "evt_1",
          content: [{ type: "text", text: "Hello from AWS!" }],
        },
        {
          type: "session.status_idle",
          id: "evt_2",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );
    mockSend.mockResolvedValue({});

    const rt = createAnthropicProvider(awsConfig);
    const result = await rt.stream({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    const parts = [];
    for await (const part of result.stream) parts.push(part);

    expect(parts.find((p) => p.type === "text-delta")).toMatchObject({
      text: "Hello from AWS!",
    });
    const response = await result.response;
    expect(response.content).toBe("Hello from AWS!");
    expect(response.sessionId).toBe("sess_aws");
  });

  it("passes awsWorkspaceId when provided", async () => {
    mockCreate.mockResolvedValue({ id: "sess_ws" });
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "session.status_idle",
          id: "evt_1",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );
    mockSend.mockResolvedValue({});

    const rt = createAnthropicProvider({
      ...awsConfig,
      awsWorkspaceId: "wrkspc_abc",
    });
    await rt.send({ messages: [{ role: MessageRole.USER, content: "hi" }] });

    expect(mockAnthropicAws).toHaveBeenCalledWith({
      awsRegion: "us-east-1",
      workspaceId: "wrkspc_abc",
    });
  });
});
