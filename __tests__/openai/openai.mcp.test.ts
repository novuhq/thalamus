import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAIProvider } from "../../src/openai/openai.provider.js";
import { collectStream } from "../../src/stream-utils.js";
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

describe("MCP server injection", () => {
  it("injects mcpServers as type:mcp tools in the API request", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_mcp" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: {
            id: "resp_mcp",
            conversation: { id: "conv_mcp" },
            status: "in_progress",
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_mcp",
            output_text: "done",
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]),
    );

    const provider = createOpenAIProvider({
      ...config,
      mcpServers: [
        {
          name: "github",
          url: "https://mcp.github.com",
          authorization: "Bearer ghp_xxx",
        },
        {
          name: "linear",
          url: "https://mcp.linear.app/mcp",
          approvalPolicy: "never",
        },
      ],
    });
    await collectStream(
      await provider.stream({
        messages: [{ role: MessageRole.USER, content: "hi" }],
      }),
    );

    const callArgs = mockResponsesCreate.mock.calls[0][0];
    const mcpTools = callArgs.tools?.filter((t: any) => t.type === "mcp");
    expect(mcpTools).toHaveLength(2);
    expect(mcpTools[0]).toMatchObject({
      type: "mcp",
      server_label: "github",
      server_url: "https://mcp.github.com",
      authorization: "Bearer ghp_xxx",
    });
    expect(mcpTools[1]).toMatchObject({
      type: "mcp",
      server_label: "linear",
      server_url: "https://mcp.linear.app/mcp",
      require_approval: "never",
    });
  });

  it("transforms approvalPolicy except to OpenAI require_approval shape", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_apol" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: {
            id: "resp_apol",
            conversation: { id: "conv_apol" },
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_apol",
            output_text: "ok",
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]),
    );

    await collectStream(
      await createOpenAIProvider({
        ...config,
        mcpServers: [
          {
            name: "deepwiki",
            url: "https://mcp.deepwiki.com/mcp",
            approvalPolicy: { except: ["ask_question", "read_wiki_structure"] },
          },
        ],
      }).stream({
        messages: [{ role: MessageRole.USER, content: "hi" }],
      }),
    );

    const callArgs = mockResponsesCreate.mock.calls[0][0];
    const mcpTool = callArgs.tools?.find(
      (t: any) => t.server_label === "deepwiki",
    );
    expect(mcpTool.require_approval).toEqual({
      never: { tool_names: ["ask_question", "read_wiki_structure"] },
    });
  });

  it("does not inject tools when mcpServers is not configured", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_no_mcp" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: {
            id: "resp_no_mcp",
            conversation: { id: "conv_no_mcp" },
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_no_mcp",
            output_text: "ok",
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]),
    );

    await collectStream(
      await createOpenAIProvider(config).stream({
        messages: [{ role: MessageRole.USER, content: "hi" }],
      }),
    );

    const callArgs = mockResponsesCreate.mock.calls[0][0];
    expect(callArgs.tools).toBeUndefined();
  });
});

describe("MCP stream events", () => {
  it("emits mcp-tools-discovered on mcp_list_tools output item", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_disc" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: {
            id: "resp_disc",
            conversation: { id: "conv_disc" },
          },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "mcp_list_tools",
            server_label: "github",
            tools: [
              {
                name: "create_issue",
                description: "Create a GitHub issue",
                input_schema: { type: "object" },
              },
            ],
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_disc",
            output_text: "",
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]),
    );

    const result = await createOpenAIProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "x" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const discovered = parts.find(
      (p) => p.type === "mcp-tools-discovered",
    ) as any;
    expect(discovered).toBeDefined();
    expect(discovered.serverName).toBe("github");
    expect(discovered.tools).toEqual([
      {
        name: "create_issue",
        description: "Create a GitHub issue",
        inputSchema: { type: "object" },
      },
    ]);
  });

  it("emits tool-use-start, tool-use-delta, tool-use-done, tool-use-result for mcp_call", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_mcpc" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: {
            id: "resp_mcpc",
            conversation: { id: "conv_mcpc" },
          },
        },
        {
          type: "response.output_item.added",
          item: {
            type: "mcp_call",
            id: "mcp_call_1",
            server_label: "github",
            name: "create_issue",
          },
          output_index: 0,
          sequence_number: 1,
        },
        {
          type: "response.mcp_call_arguments.delta",
          delta: '{"title',
          item_id: "mcp_call_1",
          output_index: 0,
          sequence_number: 2,
        },
        {
          type: "response.mcp_call_arguments.delta",
          delta: '":"Bug"}',
          item_id: "mcp_call_1",
          output_index: 0,
          sequence_number: 3,
        },
        {
          type: "response.output_item.done",
          item: {
            type: "mcp_call",
            id: "mcp_call_1",
            server_label: "github",
            name: "create_issue",
            arguments: '{"title":"Bug"}',
            output: "Created #456",
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_mcpc",
            output_text: "Done",
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]),
    );

    const result = await createOpenAIProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "x" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const toolStart = parts.find((p) => p.type === "tool-use-start") as any;
    expect(toolStart).toMatchObject({
      toolName: "create_issue",
      toolUseId: "mcp_call_1",
      source: { type: "mcp", serverName: "github" },
    });

    const deltas = parts.filter((p) => p.type === "tool-use-delta");
    expect(deltas).toEqual([
      {
        type: "tool-use-delta",
        toolUseId: "mcp_call_1",
        argumentsDelta: '{"title',
      },
      {
        type: "tool-use-delta",
        toolUseId: "mcp_call_1",
        argumentsDelta: '":"Bug"}',
      },
    ]);

    const toolDone = parts.find((p) => p.type === "tool-use-done") as any;
    expect(toolDone).toMatchObject({
      toolName: "create_issue",
      input: { title: "Bug" },
      source: { type: "mcp", serverName: "github" },
    });

    const toolResult = parts.find((p) => p.type === "tool-use-result") as any;
    expect(toolResult).toMatchObject({
      output: "Created #456",
      source: { type: "mcp", serverName: "github" },
    });
  });

  it("emits finish with requires-action on mcp_approval_request", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_appr" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: {
            id: "resp_appr",
            conversation: { id: "conv_appr" },
          },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "mcp_approval_request",
            id: "appr_1",
            server_label: "github",
            name: "create_issue",
            arguments: '{"title":"Bug"}',
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_appr",
            output_text: "",
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]),
    );

    const result = await createOpenAIProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "x" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const finish = parts.find((p) => p.type === "finish") as any;
    expect(finish.response.finishReason).toBe("requires-action");
    expect(finish.response.actionsRequired).toEqual([
      expect.objectContaining({
        type: "mcp-approval",
        toolName: "create_issue",
        serverName: "github",
      }),
    ]);
  });
});
