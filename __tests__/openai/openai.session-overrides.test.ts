import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAIProvider } from "../../src/openai/openai.provider.js";
import { MessageRole } from "../../src/types.js";
import { makeStream } from "./_helpers.js";

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
  return {
    default: MockOpenAI,
    APIError: actual.APIError,
    APIUserAbortError: actual.APIUserAbortError,
  };
});

afterEach(() => vi.clearAllMocks());

const providerConfig = {
  apiKey: "sk-test",
  model: "gpt-4o",
  mcpServers: [
    { name: "github", url: "https://api.githubcopilot.com/mcp/" },
    { name: "slack", url: "https://mcp.slack.com/sse" },
    { name: "linear", url: "https://mcp.linear.app/sse" },
  ],
};

function setupCompletedStream(sessionId: string, responseId: string) {
  mockResponsesCreate.mockReturnValue(
    makeStream([
      {
        type: "response.created",
        response: { id: responseId, conversation: { id: sessionId } },
      },
      {
        type: "response.completed",
        response: {
          id: responseId,
          output_text: "ok",
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      },
    ]),
  );
}

describe("send() with agent.mcpServers override", () => {
  it("uses overridden MCPs instead of provider defaults", async () => {
    setupCompletedStream("sess_1", "resp_1");

    const provider = createOpenAIProvider(providerConfig);
    await provider.send({
      sessionId: "sess_1",
      messages: [{ role: MessageRole.USER, content: "hello" }],
      agent: {
        mcpServers: [
          { name: "github", url: "https://api.githubcopilot.com/mcp/" },
        ],
      },
    });

    const createCall = mockResponsesCreate.mock.calls[0][0];
    const mcpTools = createCall.tools?.filter(
      (t: { type: string }) => t.type === "mcp",
    );
    expect(mcpTools).toHaveLength(1);
    expect(mcpTools[0].server_url).toBe("https://api.githubcopilot.com/mcp/");
    expect(mcpTools[0].server_label).toBe("github");
  });

  it("uses provider defaults when agent is not provided", async () => {
    setupCompletedStream("sess_2", "resp_2");

    const provider = createOpenAIProvider(providerConfig);
    await provider.send({
      sessionId: "sess_2",
      messages: [{ role: MessageRole.USER, content: "hello" }],
    });

    const createCall = mockResponsesCreate.mock.calls[0][0];
    const mcpTools = createCall.tools?.filter(
      (t: { type: string }) => t.type === "mcp",
    );
    expect(mcpTools).toHaveLength(3);
  });
});

describe("send() with agent.tools override", () => {
  it("maps AgentToolConfig to OpenAI function tools", async () => {
    setupCompletedStream("sess_3", "resp_3");

    const provider = createOpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-4o",
    });
    await provider.send({
      sessionId: "sess_3",
      messages: [{ role: MessageRole.USER, content: "hello" }],
      agent: {
        tools: [
          {
            name: "my_tool",
            description: "Does things",
            inputSchema: { type: "object" },
          },
        ],
      },
    });

    const createCall = mockResponsesCreate.mock.calls[0][0];
    const fnTools = createCall.tools?.filter(
      (t: { type: string }) => t.type === "function",
    );
    expect(fnTools).toHaveLength(1);
    expect(fnTools[0].name).toBe("my_tool");
    expect(fnTools[0].description).toBe("Does things");
    expect(fnTools[0].parameters).toEqual({ type: "object" });
  });
});

describe("send() with agent.providerTools override", () => {
  it("passes providerTools through to the API request", async () => {
    setupCompletedStream("sess_4", "resp_4");

    const provider = createOpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-4o",
    });
    await provider.send({
      sessionId: "sess_4",
      messages: [{ role: MessageRole.USER, content: "hello" }],
      agent: {
        providerTools: [{ type: "web_search" }],
      },
    });

    const createCall = mockResponsesCreate.mock.calls[0][0];
    expect(createCall.tools).toEqual([{ type: "web_search" }]);
  });
});
