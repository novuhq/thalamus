import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../../src/anthropic/anthropic.provider.js";
import { MessageRole } from "../../src/types.js";
import { awsConfig, awsSigV4Config, config, mockSse } from "./_helpers.js";

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
  return {
    default: MockAnthropic,
    APIError: actual.APIError,
    APIUserAbortError: actual.APIUserAbortError,
  };
});

vi.mock("@anthropic-ai/aws-sdk", () => ({
  AnthropicAws: mockAnthropicAws,
}));

mockAnthropicAws.mockImplementation(function (
  this: any,
  clientConfig: Record<string, unknown>,
) {
  return {
    beta: {
      sessions: {
        create: mockCreate,
        events: { stream: mockSseStream, send: mockSend },
      },
      vaults: { create: vi.fn(), retrieve: vi.fn() },
    },
    _awsConfig: clientConfig,
  };
});

afterEach(() => vi.clearAllMocks());

describe("cloud auth", () => {
  it("creates Anthropic client with cloud apiKey", async () => {
    mockCreate.mockResolvedValue({ id: "sess_cloud" });
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

    const rt = createAnthropicProvider(config);
    await rt.send({ messages: [{ role: MessageRole.USER, content: "hi" }] });

    expect(mockAnthropicAws).not.toHaveBeenCalled();
  });
});

describe("AWS API key auth — client config", () => {
  it("creates provider with awsRegion config", () => {
    const rt = createAnthropicProvider(awsConfig);
    expect(rt.provider).toBe("anthropic");
    expect(rt.runtimeId).toBe("agent_abc");
  });

  it("passes awsRegion, workspaceId, and apiKey to AnthropicAws", async () => {
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
      apiKey: "aws-api-key-abc123",
    });
  });
});

describe("AWS API key auth — streaming", () => {
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

    const parts: any[] = [];
    const rt = createAnthropicProvider({
      ...awsConfig,
      onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
    });
    const response = await rt.send({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    expect(parts.find((p) => p.type === "text-delta")).toMatchObject({
      text: "Hello from AWS!",
    });
    expect(response.content).toBe("Hello from AWS!");
    expect(response.sessionId).toBe("sess_aws");
  });
});

describe("AWS SigV4 auth — client config", () => {
  it("passes explicit AWS credentials to AnthropicAws", async () => {
    mockCreate.mockResolvedValue({ id: "sess_sigv4" });
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
      ...awsSigV4Config,
      awsCredentials: {
        ...awsSigV4Config.awsCredentials,
        sessionToken: "session-token-xyz",
      },
    });
    await rt.send({ messages: [{ role: MessageRole.USER, content: "hi" }] });

    expect(mockAnthropicAws).toHaveBeenCalledWith({
      awsRegion: "us-west-2",
      workspaceId: undefined,
      awsAccessKey: "AKIAIOSFODNN7EXAMPLE",
      awsSecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      awsSessionToken: "session-token-xyz",
    });
  });
});

describe("AWS SigV4 auth — streaming", () => {
  it("streams successfully via SigV4 credentials", async () => {
    mockCreate.mockResolvedValue({ id: "sess_sv4" });
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "agent.message",
          id: "evt_1",
          content: [{ type: "text", text: "Signed!" }],
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
    const response = await createAnthropicProvider({
      ...awsSigV4Config,
      onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
    }).send({ messages: [{ role: MessageRole.USER, content: "Hi" }] });

    expect(response.content).toBe("Signed!");
    expect(response.sessionId).toBe("sess_sv4");
  });
});

describe("AWS auth validation", () => {
  it("throws when awsRegion is set without credentials", async () => {
    const rt = createAnthropicProvider({
      agentId: "agent_abc",
      environmentId: "env_xyz",
      awsRegion: "us-east-1",
    } as Parameters<typeof createAnthropicProvider>[0]);

    await expect(
      rt.send({ messages: [{ role: MessageRole.USER, content: "hi" }] }),
    ).rejects.toThrow(
      "AWS Anthropic provider requires either apiKey or awsCredentials when awsRegion is set",
    );
    expect(mockAnthropicAws).not.toHaveBeenCalled();
  });
});
