import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../../src/anthropic/anthropic.provider.js";
import { MessageRole } from "../../src/types.js";
import { config, emptyHistory, mockSse } from "./_helpers.js";

const mockCreate = vi.fn();
const mockRetrieve = vi.fn();
const mockUpdate = vi.fn();
const mockAgentRetrieve = vi.fn();
const mockSseStream = vi.fn();
const mockSend = vi.fn();
const mockList = vi.fn(emptyHistory);

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  // biome-ignore lint/complexity/useArrowFunction: must be callable with `new`
  const MockAnthropic = function () {
    return {
      beta: {
        agents: { retrieve: mockAgentRetrieve },
        sessions: {
          create: mockCreate,
          retrieve: mockRetrieve,
          update: mockUpdate,
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

const agentTools = [
  { type: "agent_toolset_20260401" },
  { type: "mcp_toolset", mcp_server_name: "slack" },
  { type: "mcp_toolset", mcp_server_name: "github" },
  { type: "mcp_toolset", mcp_server_name: "linear" },
];

const agentMcpServers = [
  { type: "url", name: "slack", url: "https://mcp.slack.com/sse" },
  { type: "url", name: "github", url: "https://api.githubcopilot.com/mcp/" },
  { type: "url", name: "linear", url: "https://mcp.linear.app/sse" },
];

const githubOnly = {
  mcpServers: [{ name: "github", url: "https://api.githubcopilot.com/mcp/" }],
};

function mockIdleSession(
  sessionId: string,
  tools: object[],
  mcpServers: object[],
) {
  mockRetrieve.mockResolvedValue({
    id: sessionId,
    status: "idle",
    agent: { tools, mcp_servers: mcpServers },
  });
}

function setupStream() {
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
}

describe("send() with agent.mcpServers override", () => {
  it("applies overrides natively at create for a new session", async () => {
    mockAgentRetrieve.mockResolvedValue({
      id: "agent_abc",
      version: 7,
      tools: agentTools,
      mcp_servers: agentMcpServers,
    });
    mockCreate.mockResolvedValue({ id: "sess_1" });
    setupStream();

    const provider = createAnthropicProvider(config);
    const response = await provider.send({
      messages: [{ role: MessageRole.USER, content: "hello" }],
      agent: githubOnly,
    });

    expect(mockAgentRetrieve).toHaveBeenCalledWith("agent_abc");
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: {
          type: "agent_with_overrides",
          id: "agent_abc",
          version: 7,
          tools: [
            { type: "agent_toolset_20260401" },
            { type: "mcp_toolset", mcp_server_name: "github" },
          ],
          mcp_servers: [
            {
              type: "url",
              name: "github",
              url: "https://api.githubcopilot.com/mcp/",
            },
          ],
        },
        initial_events: [
          { type: "user.message", content: [{ type: "text", text: "hello" }] },
        ],
      }),
    );
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(response.messages).toEqual(["Hello!"]);
  });

  it("calls sessions.update() before dispatch on a resumed session", async () => {
    mockIdleSession("sess_1", agentTools, agentMcpServers);
    mockUpdate.mockResolvedValue({});
    setupStream();

    const provider = createAnthropicProvider(config);
    await provider.send({
      messages: [{ role: MessageRole.USER, content: "hello" }],
      sessionId: "sess_1",
      agent: githubOnly,
    });

    expect(mockUpdate).toHaveBeenCalledWith("sess_1", {
      agent: {
        tools: [
          { type: "agent_toolset_20260401" },
          { type: "mcp_toolset", mcp_server_name: "github" },
        ],
        mcp_servers: [
          {
            type: "url",
            name: "github",
            url: "https://api.githubcopilot.com/mcp/",
          },
        ],
      },
    });

    expect(mockAgentRetrieve).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalled();
    expect(mockUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mockSend.mock.invocationCallOrder[0],
    );
  });

  it("skips overrides when agent is not provided", async () => {
    mockCreate.mockResolvedValue({ id: "sess_2" });
    setupStream();

    const provider = createAnthropicProvider(config);
    await provider.send({
      messages: [{ role: MessageRole.USER, content: "hello" }],
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "agent_abc" }),
    );
    expect(mockAgentRetrieve).not.toHaveBeenCalled();
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("updates before dispatch when providerOptions sets the create agent", async () => {
    mockCreate.mockResolvedValue({ id: "sess_1" });
    mockIdleSession("sess_1", agentTools, agentMcpServers);
    mockUpdate.mockResolvedValue({});
    setupStream();

    const provider = createAnthropicProvider(config);
    await provider.send({
      messages: [{ role: MessageRole.USER, content: "hello" }],
      agent: githubOnly,
      providerOptions: {
        agent: { type: "agent", id: "agent_abc", version: 2 },
      },
    });

    const createParams = mockCreate.mock.calls[0][0];
    expect(createParams.agent).toEqual({
      type: "agent",
      id: "agent_abc",
      version: 2,
    });
    expect(createParams.initial_events).toBeUndefined();
    expect(mockUpdate).toHaveBeenCalledWith(
      "sess_1",
      expect.objectContaining({ agent: expect.any(Object) }),
    );
    expect(mockUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mockSend.mock.invocationCallOrder[0],
    );
  });
});

describe("send() with tools + providerTools override", () => {
  it("replaces non-MCP tools and preserves specified MCPs", async () => {
    mockIdleSession(
      "sess_3",
      [
        { type: "agent_toolset_20260401" },
        {
          type: "custom",
          name: "old_tool",
          description: "old",
          input_schema: {},
        },
        { type: "mcp_toolset", mcp_server_name: "github" },
      ],
      [
        {
          type: "url",
          name: "github",
          url: "https://api.githubcopilot.com/mcp/",
        },
      ],
    );
    mockUpdate.mockResolvedValue({});
    setupStream();

    const provider = createAnthropicProvider(config);
    await provider.send({
      messages: [{ role: MessageRole.USER, content: "hello" }],
      sessionId: "sess_3",
      agent: {
        tools: [
          {
            name: "my_tool",
            description: "Does things",
            inputSchema: { type: "object" },
          },
        ],
        providerTools: [{ type: "agent_toolset_20260401" }],
        mcpServers: [
          { name: "github", url: "https://api.githubcopilot.com/mcp/" },
        ],
      },
    });

    expect(mockUpdate).toHaveBeenCalledWith("sess_3", {
      agent: {
        tools: [
          { type: "agent_toolset_20260401" },
          {
            type: "custom",
            name: "my_tool",
            description: "Does things",
            input_schema: { type: "object" },
          },
          { type: "mcp_toolset", mcp_server_name: "github" },
        ],
        mcp_servers: [
          {
            type: "url",
            name: "github",
            url: "https://api.githubcopilot.com/mcp/",
          },
        ],
      },
    });
  });
});
