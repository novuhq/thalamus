import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../../src/anthropic/anthropic.provider.js";
import { ThalamusError } from "../../src/errors.js";
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

describe("stream — event mapping", () => {
  it("emits thinking part on agent.thinking event", async () => {
    mockCreate.mockResolvedValue({ id: "sess_think" });
    mockSseStream.mockResolvedValue(
      mockSse([
        { type: "agent.thinking", id: "evt_1" },
        {
          type: "session.status_idle",
          id: "evt_2",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );
    mockSend.mockResolvedValue({});

    const parts: any[] = [];
    await createAnthropicProvider({
      ...config,
      onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
    }).send({ messages: [{ role: MessageRole.USER, content: "think" }] });

    expect(parts.find((p) => p.type === "thinking")).toMatchObject({
      type: "thinking",
      text: "",
    });
  });

  it("emits tool-use-start then tool-use-done on agent.tool_use event", async () => {
    mockCreate.mockResolvedValue({ id: "sess_tool" });
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "agent.tool_use",
          id: "tu_1",
          name: "bash",
          input: { command: "ls" },
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
    await createAnthropicProvider({
      ...config,
      onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
    }).send({ messages: [{ role: MessageRole.USER, content: "run ls" }] });

    const toolStart = parts.find((p) => p.type === "tool-use-start") as any;
    expect(toolStart).toMatchObject({
      type: "tool-use-start",
      toolName: "bash",
      toolUseId: "tu_1",
    });
    expect(toolStart.source).toEqual({ type: "builtin" });

    const startIdx = parts.indexOf(toolStart);
    const toolDone = parts.find((p) => p.type === "tool-use-done") as any;
    const doneIdx = parts.indexOf(toolDone);
    expect(doneIdx).toBeGreaterThan(startIdx);

    expect(toolDone).toMatchObject({
      type: "tool-use-done",
      toolName: "bash",
      toolUseId: "tu_1",
      input: { command: "ls" },
    });
    expect(toolDone.source).toEqual({ type: "builtin" });
  });

  it("emits tool-use-result on agent.tool_result event", async () => {
    mockCreate.mockResolvedValue({ id: "sess_tr" });
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "agent.tool_result",
          id: "evt_1",
          tool_use_id: "tu_1",
          content: [{ type: "text", text: "file1.ts\nfile2.ts" }],
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
    await createAnthropicProvider({
      ...config,
      onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
    }).send({ messages: [{ role: MessageRole.USER, content: "x" }] });

    const toolResult = parts.find((p) => p.type === "tool-use-result") as any;
    expect(toolResult).toMatchObject({
      type: "tool-use-result",
      toolUseId: "tu_1",
      content: [{ type: "text", text: "file1.ts\nfile2.ts" }],
    });
    expect(toolResult.source).toEqual({ type: "builtin" });
  });

  it("emits tool-use-result on agent.mcp_tool_result with serverName from prior mcp_tool_use", async () => {
    mockCreate.mockResolvedValue({ id: "sess_mcpr" });
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "agent.mcp_tool_use",
          id: "mcp_1",
          name: "list_repos",
          mcp_server_name: "github",
          input: { org: "acme" },
        },
        {
          type: "agent.mcp_tool_result",
          id: "evt_1",
          mcp_tool_use_id: "mcp_1",
          content: [{ type: "text", text: "repo-a, repo-b" }],
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
    await createAnthropicProvider({
      ...config,
      onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
    }).send({ messages: [{ role: MessageRole.USER, content: "x" }] });

    const toolResult = parts.find((p) => p.type === "tool-use-result") as any;
    expect(toolResult).toMatchObject({
      type: "tool-use-result",
      toolUseId: "mcp_1",
      content: [{ type: "text", text: "repo-a, repo-b" }],
    });
    expect(toolResult.source).toEqual({ type: "mcp", serverName: "github" });
  });

  it("accumulates actionsRequired on agent.custom_tool_use and sets requires-action finish", async () => {
    mockCreate.mockResolvedValue({ id: "sess_ctu" });
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "agent.custom_tool_use",
          id: "ctu_1",
          name: "approve_deploy",
          input: { env: "prod" },
        },
        {
          type: "session.status_idle",
          id: "evt_2",
          stop_reason: { type: "requires_action" },
        },
      ]),
    );
    mockSend.mockResolvedValue({});

    const parts: any[] = [];
    await createAnthropicProvider({
      ...config,
      onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
    }).send({ messages: [{ role: MessageRole.USER, content: "deploy" }] });

    const finish = parts.find((p) => p.type === "finish") as any;
    expect(finish.response.finishReason).toBe("requires-action");
    expect(finish.response.actionsRequired).toEqual([
      {
        type: "tool-confirmation",
        toolUseId: "ctu_1",
        toolName: "approve_deploy",
        input: { env: "prod" },
      },
    ]);
  });

  it("accumulates actionsRequired on agent.tool_use with evaluated_permission ask", async () => {
    mockCreate.mockResolvedValue({ id: "sess_perm" });
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "agent.tool_use",
          id: "sevt_1",
          name: "bash",
          input: { command: "uname -a" },
          evaluated_permission: "ask",
        },
        {
          type: "agent.tool_use",
          id: "sevt_2",
          name: "bash",
          input: { command: "whoami" },
          evaluated_permission: "ask",
        },
        {
          type: "session.status_idle",
          id: "evt_idle",
          stop_reason: {
            type: "requires_action",
            event_ids: ["sevt_1", "sevt_2"],
          },
        },
      ]),
    );
    mockSend.mockResolvedValue({});

    const parts: any[] = [];
    await createAnthropicProvider({
      ...config,
      onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
    }).send({ messages: [{ role: MessageRole.USER, content: "run stuff" }] });

    const finish = parts.find((p) => p.type === "finish") as any;
    expect(finish.response.finishReason).toBe("requires-action");
    expect(finish.response.actionsRequired).toEqual([
      {
        type: "tool-confirmation",
        toolUseId: "sevt_1",
        toolName: "bash",
        input: { command: "uname -a" },
      },
      {
        type: "tool-confirmation",
        toolUseId: "sevt_2",
        toolName: "bash",
        input: { command: "whoami" },
      },
    ]);
  });

  it("accumulates actionsRequired on agent.mcp_tool_use with evaluated_permission ask", async () => {
    mockCreate.mockResolvedValue({ id: "sess_mcp_perm" });
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "agent.mcp_tool_use",
          id: "mcp_1",
          name: "list_repos",
          mcp_server_name: "github",
          input: { org: "acme" },
          evaluated_permission: "ask",
        },
        {
          type: "session.status_idle",
          id: "evt_idle",
          stop_reason: {
            type: "requires_action",
            event_ids: ["mcp_1"],
          },
        },
      ]),
    );
    mockSend.mockResolvedValue({});

    const parts: any[] = [];
    await createAnthropicProvider({
      ...config,
      onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
    }).send({ messages: [{ role: MessageRole.USER, content: "list repos" }] });

    const finish = parts.find((p) => p.type === "finish") as any;
    expect(finish.response.finishReason).toBe("requires-action");
    expect(finish.response.actionsRequired).toEqual([
      {
        type: "mcp-approval",
        toolUseId: "mcp_1",
        toolName: "list_repos",
        serverName: "github",
        input: { org: "acme" },
      },
    ]);
  });

  it("does not add actionsRequired when evaluated_permission is allow", async () => {
    mockCreate.mockResolvedValue({ id: "sess_allow" });
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "agent.tool_use",
          id: "tu_1",
          name: "bash",
          input: { command: "ls" },
          evaluated_permission: "allow",
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
    await createAnthropicProvider({
      ...config,
      onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
    }).send({ messages: [{ role: MessageRole.USER, content: "run ls" }] });

    const finish = parts.find((p) => p.type === "finish") as any;
    expect(finish.response.finishReason).toBe("stop");
    expect(finish.response.actionsRequired).toBeUndefined();
  });

  it("emits status-change running on session.status_running", async () => {
    mockCreate.mockResolvedValue({ id: "sess_run" });
    mockSseStream.mockResolvedValue(
      mockSse([
        { type: "session.status_running", id: "evt_1" },
        {
          type: "session.status_idle",
          id: "evt_2",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );
    mockSend.mockResolvedValue({});

    const parts: any[] = [];
    await createAnthropicProvider({
      ...config,
      onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
    }).send({ messages: [{ role: MessageRole.USER, content: "x" }] });

    expect(parts.find((p) => p.type === "status-change")).toMatchObject({
      status: "running",
    });
  });

  it("emits status-change retrying on session.status_rescheduled", async () => {
    mockCreate.mockResolvedValue({ id: "sess_resch" });
    mockSseStream.mockResolvedValue(
      mockSse([
        { type: "session.status_rescheduled", id: "evt_1" },
        {
          type: "session.status_idle",
          id: "evt_2",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );
    mockSend.mockResolvedValue({});

    const parts: any[] = [];
    await createAnthropicProvider({
      ...config,
      onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
    }).send({ messages: [{ role: MessageRole.USER, content: "x" }] });

    expect(parts.find((p) => p.type === "status-change")).toMatchObject({
      status: "retrying",
    });
  });

  it("throws on session.status_terminated", async () => {
    mockCreate.mockResolvedValue({ id: "sess_term" });
    mockSseStream.mockResolvedValue(
      mockSse([{ type: "session.status_terminated", id: "evt_1" }]),
    );
    mockSend.mockResolvedValue({});

    const parts: any[] = [];
    try {
      await createAnthropicProvider({
        ...config,
        onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
      }).send({ messages: [{ role: MessageRole.USER, content: "x" }] });
    } catch (_) {}

    const errPart = parts.find((p) => p.type === "error");
    expect(errPart).toBeDefined();
    expect((errPart as any).error).toBeInstanceOf(ThalamusError);
    expect((errPart as any).error.message).toBe("Session terminated");
  });

  it("tracks usage from span.model_request_end", async () => {
    mockCreate.mockResolvedValue({ id: "sess_usage" });
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "agent.message",
          id: "evt_1",
          content: [{ type: "text", text: "Hi" }],
        },
        {
          type: "span.model_request_end",
          id: "evt_2",
          model_usage: { input_tokens: 10, output_tokens: 5 },
        },
        {
          type: "session.status_idle",
          id: "evt_3",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );
    mockSend.mockResolvedValue({});

    const response = await createAnthropicProvider(config).send({
      messages: [{ role: MessageRole.USER, content: "x" }],
    });

    expect(response.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it("emits provider-event for unknown event types", async () => {
    mockCreate.mockResolvedValue({ id: "sess_unk" });
    mockSseStream.mockResolvedValue(
      mockSse([
        { type: "some.future_event", id: "evt_1", foo: "bar" },
        {
          type: "session.status_idle",
          id: "evt_2",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );
    mockSend.mockResolvedValue({});

    const parts: any[] = [];
    await createAnthropicProvider({
      ...config,
      onSessionEvents: () => ({ onPart: (p) => parts.push(p) }),
    }).send({ messages: [{ role: MessageRole.USER, content: "x" }] });

    const providerEvent = parts.find((p) => p.type === "provider-event") as any;
    expect(providerEvent).toBeDefined();
    expect(providerEvent.provider).toBe("anthropic");
    expect(providerEvent.event).toBe("some.future_event");
    expect(providerEvent.data.foo).toBe("bar");
  });
});
