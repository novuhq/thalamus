import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderAuthError, ThalamusError } from "../../src/errors.js";
import { createOpenAIProvider } from "../../src/openai/openai.provider.js";
import { collectStream } from "../../src/stream-utils.js";
import { MessageRole } from "../../src/types.js";
import { createMemoryVaultStore } from "../../src/vault/memory-vault-store.js";

function makeStream(events: object[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
  };
}

const mockResponsesCreate = vi.fn();
const mockConversationsCreate = vi.fn();
let lastOpenAIConfig: Record<string, unknown> | undefined;

vi.mock("openai", () => {
  // biome-ignore lint/complexity/useArrowFunction: must be callable with `new`
  const MockOpenAI = function (config: Record<string, unknown>) {
    lastOpenAIConfig = config;
    return {
      responses: { create: mockResponsesCreate },
      conversations: { create: mockConversationsCreate },
    };
  };
  return { default: MockOpenAI };
});

afterEach(() => vi.clearAllMocks());

const config = {
  apiKey: "sk-test",
  model: "gpt-4o",
  instructions: "Be helpful.",
};

describe("createOpenAIProvider", () => {
  it("sets provider = openai and runtimeId = inline when no promptId", () => {
    const rt = createOpenAIProvider(config);
    expect(rt.provider).toBe("openai");
    expect(rt.runtimeId).toBe("inline");
  });

  it("uses promptId as runtimeId when provided", () => {
    expect(
      createOpenAIProvider({ ...config, promptId: "pmpt_abc" }).runtimeId,
    ).toBe("pmpt_abc");
  });
});

describe("stream — new session (conversation)", () => {
  it("creates a conversation, yields stream-start with conversationId, resolves response", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_new" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_1", conversation: { id: "conv_new" } },
        },
        { type: "response.output_text.delta", delta: "Hello" },
        { type: "response.output_text.delta", delta: " world" },
        {
          type: "response.completed",
          response: {
            id: "resp_1",
            output_text: "Hello world",
            usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
          },
        },
      ]),
    );

    const result = await createOpenAIProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    const parts = [];
    for await (const p of result.stream) parts.push(p);

    expect(mockConversationsCreate).toHaveBeenCalledOnce();
    expect(parts.find((p) => p.type === "stream-start")).toMatchObject({
      sessionId: "conv_new",
    });
    expect(parts.filter((p) => p.type === "text-delta")).toHaveLength(2);

    const response = await result.response;
    expect(response.content).toBe("Hello world");
    expect(response.sessionId).toBe("conv_new");
    expect(response.usage?.inputTokens).toBe(5);
  });
});

describe("stream — resume session (conversation)", () => {
  it("passes conversation id when sessionId is provided, skips conversations.create", async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_2", conversation: { id: "conv_existing" } },
        },
        {
          type: "response.completed",
          response: { id: "resp_2", output_text: "ok", usage: {} },
        },
      ]),
    );

    await collectStream(
      await createOpenAIProvider(config).stream({
        messages: [{ role: MessageRole.USER, content: "next" }],
        sessionId: "conv_existing",
      }),
    );

    expect(mockConversationsCreate).not.toHaveBeenCalled();
    expect(mockResponsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ conversation: { id: "conv_existing" } }),
    );
  });
});

describe("multiple messages", () => {
  it("passes all messages as input", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_hist" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_3", conversation: { id: "conv_hist" } },
        },
        {
          type: "response.completed",
          response: { id: "resp_3", output_text: "", usage: {} },
        },
      ]),
    );

    await collectStream(
      await createOpenAIProvider(config).stream({
        messages: [
          { role: MessageRole.SYSTEM, content: "You are helpful" },
          { role: MessageRole.USER, content: "current" },
        ],
      }),
    );

    const callInput = mockResponsesCreate.mock.calls[0][0].input;
    expect(callInput).toHaveLength(2);
  });
});

describe("tool call streaming", () => {
  it("emits tool-use-start, tool-use-delta, tool-use-done in sequence", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_tool" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_t", conversation: { id: "conv_tool" } },
        },
        {
          type: "response.output_item.added",
          item: {
            type: "function_call",
            name: "get_weather",
            call_id: "call_1",
          },
          output_index: 0,
          sequence_number: 1,
        },
        {
          type: "response.function_call_arguments.delta",
          delta: '{"lo',
          item_id: "call_1",
          output_index: 0,
          sequence_number: 2,
        },
        {
          type: "response.function_call_arguments.delta",
          delta: 'c":"NYC"}',
          item_id: "call_1",
          output_index: 0,
          sequence_number: 3,
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            name: "get_weather",
            call_id: "call_1",
            arguments: '{"loc":"NYC"}',
          },
          output_index: 0,
          sequence_number: 4,
        },
        {
          type: "response.completed",
          response: { id: "resp_t", output_text: "", usage: {} },
        },
      ]),
    );

    const result = await createOpenAIProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "weather?" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const toolParts = parts.filter(
      (p) =>
        p.type === "tool-use-start" ||
        p.type === "tool-use-delta" ||
        p.type === "tool-use-done",
    );
    expect(toolParts).toEqual([
      {
        type: "tool-use-start",
        toolName: "get_weather",
        toolUseId: "call_1",
        source: { type: "builtin" },
      },
      { type: "tool-use-delta", toolUseId: "call_1", argumentsDelta: '{"lo' },
      {
        type: "tool-use-delta",
        toolUseId: "call_1",
        argumentsDelta: 'c":"NYC"}',
      },
      {
        type: "tool-use-done",
        toolName: "get_weather",
        toolUseId: "call_1",
        input: { loc: "NYC" },
        source: { type: "builtin" },
      },
    ]);
  });
});

describe("tool call source tagging", () => {
  it("emits source: builtin on function_call events", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_src" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_src", conversation: { id: "conv_src" } },
        },
        {
          type: "response.output_item.added",
          item: {
            type: "function_call",
            name: "get_weather",
            call_id: "fc_1",
          },
          output_index: 0,
          sequence_number: 1,
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            name: "get_weather",
            call_id: "fc_1",
            arguments: "{}",
          },
          output_index: 0,
          sequence_number: 2,
        },
        {
          type: "response.completed",
          response: { id: "resp_src", output_text: "done", usage: {} },
        },
      ]),
    );

    const result = await createOpenAIProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "weather" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const toolStart = parts.find((p) => p.type === "tool-use-start") as any;
    expect(toolStart.source).toEqual({ type: "builtin" });
    const toolDone = parts.find((p) => p.type === "tool-use-done") as any;
    expect(toolDone.source).toEqual({ type: "builtin" });
  });
});

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

describe("refusal handling", () => {
  it("emits refusal parts and sets finishReason to refused", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_ref" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_r", conversation: { id: "conv_ref" } },
        },
        {
          type: "response.refusal.delta",
          delta: "I cannot",
          item_id: "item_1",
          content_index: 0,
          output_index: 0,
          sequence_number: 1,
        },
        {
          type: "response.refusal.delta",
          delta: " help with that.",
          item_id: "item_1",
          content_index: 0,
          output_index: 0,
          sequence_number: 2,
        },
        {
          type: "response.completed",
          response: { id: "resp_r", output_text: "", usage: {} },
        },
      ]),
    );

    const result = await createOpenAIProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "do something bad" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    expect(parts.filter((p) => p.type === "refusal")).toEqual([
      { type: "refusal", text: "I cannot" },
      { type: "refusal", text: " help with that." },
    ]);

    const response = await result.response;
    expect(response.finishReason).toBe("refused");
  });
});

describe("error handling", () => {
  it("maps invalid_api_key to ProviderAuthError", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_err" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "error",
          message: "Incorrect API key",
          code: "invalid_api_key",
        },
      ]),
    );

    const result = await createOpenAIProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "x" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    expect(
      (parts.find((p) => p.type === "error") as any)?.error,
    ).toBeInstanceOf(ProviderAuthError);
    await expect(result.response).rejects.toBeInstanceOf(ProviderAuthError);
  });
});

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

    const result = await createOpenAIProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "think" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

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

    const result = await createOpenAIProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "x" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

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

    const result = await createOpenAIProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "x" }],
    });
    result.response.catch(() => {});

    const parts = [];
    for await (const p of result.stream) parts.push(p);

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

    const result = await createOpenAIProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "x" }],
    });
    const response = await collectStream(result);

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

    const result = await createOpenAIProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "x" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const providerEvent = parts.find((p) => p.type === "provider-event") as any;
    expect(providerEvent).toBeDefined();
    expect(providerEvent.provider).toBe("openai");
    expect(providerEvent.event).toBe("response.some_future_event");
  });
});

describe("error handling — additional cases", () => {
  it("maps rate_limit_exceeded to ProviderRateLimitError", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_rl" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "error",
          message: "Rate limit exceeded",
          code: "rate_limit_exceeded",
        },
      ]),
    );

    const result = await createOpenAIProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "x" }],
    });
    result.response.catch(() => {});

    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const { ProviderRateLimitError } = await import("../../src/errors.js");
    expect(
      (parts.find((p) => p.type === "error") as any)?.error,
    ).toBeInstanceOf(ProviderRateLimitError);
  });

  it("maps thrown unavailable error to ProviderUnavailableError", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_503" });
    mockResponsesCreate.mockImplementation(() => {
      throw new Error("Service unavailable");
    });

    const result = await createOpenAIProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "x" }],
    });
    result.response.catch(() => {});

    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const { ProviderUnavailableError } = await import("../../src/errors.js");
    expect(
      (parts.find((p) => p.type === "error") as any)?.error,
    ).toBeInstanceOf(ProviderUnavailableError);
  });
});

// --- Bedrock API Key auth ---

const bedrockConfig = {
  awsRegion: "us-east-1",
  awsBedrockApiKey: "bedrock-api-key-abc123",
  model: "openai.gpt-oss-120b",
  instructions: "Be helpful.",
};

describe("Bedrock API Key auth — client config", () => {
  it("passes bedrock-mantle baseURL and awsBedrockApiKey to OpenAI client", () => {
    createOpenAIProvider(bedrockConfig);
    expect(lastOpenAIConfig).toMatchObject({
      baseURL: "https://bedrock-mantle.us-east-1.api.aws/v1",
      apiKey: "bedrock-api-key-abc123",
    });
  });

  it("does NOT set baseURL for direct OpenAI config", () => {
    createOpenAIProvider(config);
    expect(lastOpenAIConfig?.apiKey).toBe("sk-test");
    expect(lastOpenAIConfig?.baseURL).toBeUndefined();
  });
});

describe("Bedrock API Key auth — streaming", () => {
  it("streams successfully via bedrock-mantle endpoint", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_br" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_br", conversation: { id: "conv_br" } },
        },
        { type: "response.output_text.delta", delta: "Hello from Bedrock!" },
        {
          type: "response.completed",
          response: {
            id: "resp_br",
            output_text: "Hello from Bedrock!",
            usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
          },
        },
      ]),
    );

    const result = await createOpenAIProvider(bedrockConfig).stream({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const response = await result.response;
    expect(response.content).toBe("Hello from Bedrock!");
    expect(response.sessionId).toBe("conv_br");
  });

  it("sets provider = openai and runtimeId = inline", () => {
    const rt = createOpenAIProvider(bedrockConfig);
    expect(rt.provider).toBe("openai");
    expect(rt.runtimeId).toBe("inline");
  });
});

// --- Bedrock SigV4 auth ---

const sigv4Config = {
  awsRegion: "us-west-2",
  awsCredentials: {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  },
  model: "openai.gpt-oss-120b",
};

describe("Bedrock SigV4 auth — client config", () => {
  it("passes bedrock-mantle baseURL and custom fetch to OpenAI client", () => {
    createOpenAIProvider(sigv4Config);
    expect(lastOpenAIConfig?.baseURL).toBe(
      "https://bedrock-mantle.us-west-2.api.aws/v1",
    );
    expect(typeof lastOpenAIConfig?.fetch).toBe("function");
    expect(lastOpenAIConfig?.apiKey).toBe("bedrock-sigv4");
  });
});

describe("Bedrock — no Conversations API (previous_response_id fallback)", () => {
  it("does NOT call conversations.create on Bedrock config", async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_br_f1", conversation: null },
        },
        { type: "response.output_text.delta", delta: "hi" },
        {
          type: "response.completed",
          response: { id: "resp_br_f1", output_text: "hi", usage: {} },
        },
      ]),
    );

    await collectStream(
      await createOpenAIProvider(bedrockConfig).stream({
        messages: [{ role: MessageRole.USER, content: "hello" }],
      }),
    );

    expect(mockConversationsCreate).not.toHaveBeenCalled();
  });

  it("uses response ID as sessionId when no conversation is returned", async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_br_f2", conversation: null },
        },
        {
          type: "response.completed",
          response: { id: "resp_br_f2", output_text: "ok", usage: {} },
        },
      ]),
    );

    const result = await createOpenAIProvider(bedrockConfig).stream({
      messages: [{ role: MessageRole.USER, content: "hi" }],
    });
    const response = await collectStream(result);
    expect(response.sessionId).toBe("resp_br_f2");
  });

  it("passes previous_response_id on session resume", async () => {
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_br_f3", conversation: null },
        },
        {
          type: "response.completed",
          response: { id: "resp_br_f3", output_text: "ok", usage: {} },
        },
      ]),
    );

    await collectStream(
      await createOpenAIProvider(bedrockConfig).stream({
        messages: [{ role: MessageRole.USER, content: "next" }],
        sessionId: "resp_br_prev",
      }),
    );

    expect(mockConversationsCreate).not.toHaveBeenCalled();
    expect(mockResponsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ previous_response_id: "resp_br_prev" }),
    );
    expect(mockResponsesCreate.mock.calls[0][0].conversation).toBeUndefined();
  });
});

describe("Bedrock SigV4 auth — streaming", () => {
  it("streams successfully via SigV4-signed requests", async () => {
    mockConversationsCreate.mockResolvedValue({ id: "conv_sv4" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: { id: "resp_sv4", conversation: { id: "conv_sv4" } },
        },
        { type: "response.output_text.delta", delta: "Signed!" },
        {
          type: "response.completed",
          response: { id: "resp_sv4", output_text: "Signed!", usage: {} },
        },
      ]),
    );

    const result = await createOpenAIProvider(sigv4Config).stream({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const response = await result.response;
    expect(response.content).toBe("Signed!");
  });
});

describe("vault support", () => {
  it("createVault creates a vault in the VaultStore", async () => {
    const store = createMemoryVaultStore();
    const provider = createOpenAIProvider({ ...config, vaultStore: store });

    const vault = await provider.createVault({ name: "Alice" });
    expect(vault.id).toBeDefined();
    expect(vault.provider).toBe("openai");

    const record = await store.getVault(vault.id);
    expect(record).not.toBeNull();
    expect(record!.name).toBe("Alice");
  });

  it("getVault retrieves an existing vault", async () => {
    const store = createMemoryVaultStore();
    const provider = createOpenAIProvider({ ...config, vaultStore: store });

    const created = await provider.createVault({ name: "Bob" });
    const retrieved = await provider.getVault(created.id);
    expect(retrieved.id).toBe(created.id);
  });

  it("getVault throws for nonexistent vault", async () => {
    const store = createMemoryVaultStore();
    const provider = createOpenAIProvider({ ...config, vaultStore: store });

    await expect(provider.getVault("vlt_nope")).rejects.toThrow(
      "Vault not found",
    );
  });

  it("createVault throws if no vaultStore configured", async () => {
    const provider = createOpenAIProvider(config);

    await expect(provider.createVault({ name: "Alice" })).rejects.toThrow(
      "vaultStore is required",
    );
  });
});

describe("session lifecycle with vault", () => {
  it("vaultIds on stream() injects credentials per-request", async () => {
    const store = createMemoryVaultStore();
    const provider = createOpenAIProvider({
      ...config,
      vaultStore: store,
      mcpServers: [{ name: "github", url: "https://mcp.github.com" }],
    });

    const vault = await provider.createVault({ name: "Bob" });
    await vault.add("github", { type: "bearer", token: "ghp_yyy" });

    mockConversationsCreate.mockResolvedValue({ id: "conv_sl" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: {
            id: "resp_sl",
            conversation: { id: "conv_sl" },
            status: "in_progress",
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_sl",
            output_text: "ok",
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]),
    );

    await collectStream(
      await provider.stream({
        messages: [{ role: MessageRole.USER, content: "hi" }],
        vaultIds: [vault.id],
      }),
    );

    const callArgs = mockResponsesCreate.mock.calls[0][0];
    const mcpTool = callArgs.tools?.find(
      (t: any) => t.type === "mcp" && t.server_label === "github",
    );
    expect(mcpTool.authorization).toBe("ghp_yyy");
  });

  it("vault credential takes priority over static server.authorization", async () => {
    const store = createMemoryVaultStore();
    const provider = createOpenAIProvider({
      ...config,
      vaultStore: store,
      mcpServers: [
        {
          name: "github",
          url: "https://mcp.github.com",
          authorization: "Bearer static_token",
        },
      ],
    });

    const vault = await provider.createVault({ name: "Carol" });
    await vault.add("github", { type: "bearer", token: "ghp_dynamic" });

    mockConversationsCreate.mockResolvedValue({ id: "conv_pri" });
    mockResponsesCreate.mockReturnValue(
      makeStream([
        {
          type: "response.created",
          response: {
            id: "resp_pri",
            conversation: { id: "conv_pri" },
            status: "in_progress",
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_pri",
            output_text: "ok",
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]),
    );

    await collectStream(
      await provider.stream({
        messages: [{ role: MessageRole.USER, content: "hi" }],
        vaultIds: [vault.id],
      }),
    );

    const callArgs = mockResponsesCreate.mock.calls[0][0];
    const mcpTool = callArgs.tools?.find(
      (t: any) => t.type === "mcp" && t.server_label === "github",
    );
    expect(mcpTool.authorization).toBe("ghp_dynamic");
  });
});
