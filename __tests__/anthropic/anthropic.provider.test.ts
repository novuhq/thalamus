import { APIError } from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../../src/anthropic/anthropic.provider.js";
import { SessionExpiredError, ThalamusError } from "../../src/errors.js";
import { collectStream } from "../../src/stream-utils.js";
import { MessageRole } from "../../src/types.js";

function mockSse(events: object[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
  };
}

const mockCreate = vi.fn();
const mockSseStream = vi.fn();
const mockSend = vi.fn();
const mockVaultCreate = vi.fn();
const mockVaultRetrieve = vi.fn();
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
        vaults: {
          create: mockVaultCreate,
          retrieve: mockVaultRetrieve,
        },
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
      vaults: {
        create: mockVaultCreate,
        retrieve: mockVaultRetrieve,
      },
    },
    _awsConfig: config,
  };
});

afterEach(() => vi.clearAllMocks());

const config = {
  apiKey: "sk-test",
  agentId: "agent_abc",
  environmentId: "env_xyz",
};

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
    const result = await rt.stream({
      messages: [{ role: MessageRole.USER, content: "Hi" }],
    });

    const parts = [];
    for await (const part of result.stream) parts.push(part);

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockSend).toHaveBeenCalledOnce();
    expect(parts.find((p) => p.type === "stream-start")).toMatchObject({
      sessionId: "sess_new",
    });
    expect(parts.find((p) => p.type === "text-delta")).toMatchObject({
      text: "Hello!",
    });
    expect(parts.find((p) => p.type === "finish")).toBeDefined();

    const response = await result.response;
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
    await collectStream(
      await rt.stream({
        messages: [{ role: MessageRole.USER, content: "next" }],
        sessionId: "sess_existing",
      }),
    );

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSseStream).toHaveBeenCalledWith("sess_existing");
  });
});

describe("send", () => {
  it("returns the full response (delegates to stream + collectStream)", async () => {
    mockCreate.mockResolvedValue({ id: "sess_s" });
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "agent.message",
          id: "evt_1",
          content: [{ type: "text", text: "Done." }],
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
    const response = await rt.send({
      messages: [{ role: MessageRole.USER, content: "ping" }],
    });
    expect(response.content).toBe("Done.");
  });
});

describe("error mapping", () => {
  it("emits an error stream part on session.error", async () => {
    mockCreate.mockResolvedValue({ id: "sess_err" });
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "session.error",
          id: "evt_1",
          error: { message: "Unauthorized", type: "authentication_error" },
        },
      ]),
    );
    mockSend.mockResolvedValue({});

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "x" }],
    });
    result.response.catch(() => {});

    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const errPart = parts.find((p) => p.type === "error");
    expect(errPart).toBeDefined();
    expect((errPart as any).error).toBeInstanceOf(ThalamusError);
  });
});

const awsConfig = {
  agentId: "agent_abc",
  environmentId: "env_xyz",
  awsRegion: "us-east-1",
};

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

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "think" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    expect(parts.find((p) => p.type === "thinking")).toMatchObject({
      type: "thinking",
      text: "",
    });
  });

  it("emits tool-use-done on agent.tool_use event", async () => {
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

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "run ls" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    expect(parts.find((p) => p.type === "tool-use-done")).toMatchObject({
      type: "tool-use-done",
      toolName: "bash",
      toolUseId: "tu_1",
      input: { command: "ls" },
    });
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

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "x" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    expect(parts.find((p) => p.type === "tool-use-result")).toMatchObject({
      type: "tool-use-result",
      toolUseId: "tu_1",
      output: "file1.ts\nfile2.ts",
    });
  });

  it("emits tool-use-done on agent.mcp_tool_use event", async () => {
    mockCreate.mockResolvedValue({ id: "sess_mcp" });
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "agent.mcp_tool_use",
          id: "mcp_1",
          name: "list_repos",
          input: { org: "acme" },
        },
        {
          type: "session.status_idle",
          id: "evt_2",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );
    mockSend.mockResolvedValue({});

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "list repos" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    expect(parts.find((p) => p.type === "tool-use-done")).toMatchObject({
      type: "tool-use-done",
      toolName: "list_repos",
      toolUseId: "mcp_1",
      input: { org: "acme" },
    });
  });

  it("emits tool-use-result on agent.mcp_tool_result event", async () => {
    mockCreate.mockResolvedValue({ id: "sess_mcpr" });
    mockSseStream.mockResolvedValue(
      mockSse([
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

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "x" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    expect(parts.find((p) => p.type === "tool-use-result")).toMatchObject({
      type: "tool-use-result",
      toolUseId: "mcp_1",
      output: "repo-a, repo-b",
    });
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

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "deploy" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

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

  it("emits source: builtin on agent.tool_use", async () => {
    mockCreate.mockResolvedValue({ id: "sess_src_bt" });
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

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "run ls" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const toolDone = parts.find((p) => p.type === "tool-use-done") as any;
    expect(toolDone.source).toEqual({ type: "builtin" });
  });

  it("emits source: builtin on agent.tool_result", async () => {
    mockCreate.mockResolvedValue({ id: "sess_src_btr" });
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "agent.tool_result",
          id: "evt_1",
          tool_use_id: "tu_1",
          content: [{ type: "text", text: "file1.ts" }],
        },
        {
          type: "session.status_idle",
          id: "evt_2",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );
    mockSend.mockResolvedValue({});

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "x" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const toolResult = parts.find((p) => p.type === "tool-use-result") as any;
    expect(toolResult.source).toEqual({ type: "builtin" });
  });

  it("emits source: mcp on agent.mcp_tool_use with serverName", async () => {
    mockCreate.mockResolvedValue({ id: "sess_src_mcp" });
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "agent.mcp_tool_use",
          id: "mcp_1",
          name: "create_issue",
          input: {},
          mcp_server_name: "github",
        },
        {
          type: "session.status_idle",
          id: "evt_2",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );
    mockSend.mockResolvedValue({});

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "create issue" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const toolDone = parts.find((p) => p.type === "tool-use-done") as any;
    expect(toolDone.source).toEqual({ type: "mcp", serverName: "github" });
  });

  it("emits source: mcp on agent.mcp_tool_result", async () => {
    mockCreate.mockResolvedValue({ id: "sess_src_mcpr" });
    mockSseStream.mockResolvedValue(
      mockSse([
        {
          type: "agent.mcp_tool_result",
          id: "evt_1",
          mcp_tool_use_id: "mcp_1",
          content: [{ type: "text", text: "Created #456" }],
        },
        {
          type: "session.status_idle",
          id: "evt_2",
          stop_reason: { type: "end_turn" },
        },
      ]),
    );
    mockSend.mockResolvedValue({});

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "x" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const toolResult = parts.find((p) => p.type === "tool-use-result") as any;
    expect(toolResult.source).toEqual({ type: "mcp", serverName: "" });
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

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "x" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

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

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "x" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

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

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "x" }],
    });
    result.response.catch(() => {});

    const parts = [];
    for await (const p of result.stream) parts.push(p);

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

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "x" }],
    });
    const response = await collectStream(result);

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

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "x" }],
    });
    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const providerEvent = parts.find((p) => p.type === "provider-event") as any;
    expect(providerEvent).toBeDefined();
    expect(providerEvent.provider).toBe("anthropic");
    expect(providerEvent.event).toBe("some.future_event");
    expect(providerEvent.data.foo).toBe("bar");
  });
});

describe("session expiry detection", () => {
  it("throws SessionExpiredError when SSE stream returns 404 on resume", async () => {
    const notFoundError = new APIError(404, undefined, "Not Found", undefined);
    mockSseStream.mockRejectedValue(notFoundError);

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "hello" }],
      sessionId: "sess_expired",
    });
    result.response.catch(() => {});

    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const errPart = parts.find((p) => p.type === "error");
    expect(errPart).toBeDefined();
    expect((errPart as any).error).toBeInstanceOf(SessionExpiredError);
    expect((errPart as any).error.sessionId).toBe("sess_expired");
    expect((errPart as any).error.isRetryable).toBe(true);
  });

  it("throws SessionExpiredError when SSE stream returns 410 on resume", async () => {
    const goneError = new APIError(410, undefined, "Gone", undefined);
    mockSseStream.mockRejectedValue(goneError);

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "hello" }],
      sessionId: "sess_gone",
    });
    result.response.catch(() => {});

    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const errPart = parts.find((p) => p.type === "error");
    expect(errPart).toBeDefined();
    expect((errPart as any).error).toBeInstanceOf(SessionExpiredError);
    expect((errPart as any).error.sessionId).toBe("sess_gone");
  });

  it("does NOT throw SessionExpiredError for other errors", async () => {
    const serverError = new APIError(
      500,
      undefined,
      "Internal Server Error",
      undefined,
    );
    mockSseStream.mockRejectedValue(serverError);

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "hello" }],
      sessionId: "sess_other",
    });
    result.response.catch(() => {});

    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const errPart = parts.find((p) => p.type === "error");
    expect(errPart).toBeDefined();
    expect((errPart as any).error).not.toBeInstanceOf(SessionExpiredError);
  });

  it("does NOT throw SessionExpiredError for 404 on new session (no sessionId)", async () => {
    const notFoundError = Object.assign(new Error("Not Found"), {
      status: 404,
    });
    mockCreate.mockRejectedValue(notFoundError);

    const result = await createAnthropicProvider(config).stream({
      messages: [{ role: MessageRole.USER, content: "hello" }],
    });
    result.response.catch(() => {});

    const parts = [];
    for await (const p of result.stream) parts.push(p);

    const errPart = parts.find((p) => p.type === "error");
    expect(errPart).toBeDefined();
    expect((errPart as any).error).not.toBeInstanceOf(SessionExpiredError);
  });
});

describe("vault support", () => {
  it("createVault proxies to Anthropic vaults.create", async () => {
    mockVaultCreate.mockResolvedValue({
      id: "vlt_abc",
      display_name: "Alice",
    });

    const provider = createAnthropicProvider(config);
    const vault = await provider.createVault({
      name: "Alice",
      metadata: { subscriberId: "sub_123" },
    });

    expect(vault.id).toBe("vlt_abc");
    expect(vault.provider).toBe("anthropic");
    expect(mockVaultCreate).toHaveBeenCalledWith({
      display_name: "Alice",
      metadata: { subscriberId: "sub_123" },
    });
  });

  it("getVault proxies to Anthropic vaults.retrieve", async () => {
    mockVaultRetrieve.mockResolvedValue({
      id: "vlt_abc",
      display_name: "Alice",
    });

    const provider = createAnthropicProvider(config);
    const vault = await provider.getVault("vlt_abc");

    expect(vault.id).toBe("vlt_abc");
    expect(mockVaultRetrieve).toHaveBeenCalledWith("vlt_abc");
  });
});

describe("session lifecycle", () => {
  it("createSession creates a session with vault_ids", async () => {
    mockCreate.mockResolvedValue({ id: "sess_vault" });

    const provider = createAnthropicProvider(config);
    const sessionId = await provider.createSession({
      vaultIds: ["vlt_abc", "vlt_shared"],
    });

    expect(sessionId).toBe("sess_vault");
    expect(mockCreate).toHaveBeenCalledWith({
      agent: "agent_abc",
      environment_id: "env_xyz",
      vault_ids: ["vlt_abc", "vlt_shared"],
    });
  });

  it("createSession without vaultIds creates session without vault_ids", async () => {
    mockCreate.mockResolvedValue({ id: "sess_no_vault" });

    const provider = createAnthropicProvider(config);
    const sessionId = await provider.createSession();

    expect(sessionId).toBe("sess_no_vault");
    expect(mockCreate).toHaveBeenCalledWith({
      agent: "agent_abc",
      environment_id: "env_xyz",
    });
  });
});

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
    await collectStream(
      await provider.stream({
        messages: [{ role: MessageRole.USER, content: "" }],
        sessionId: "sess_appr",
        toolResults: [{ toolUseId: "tu_789", approved: true }],
      }),
    );

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
    await collectStream(
      await provider.stream({
        messages: [{ role: MessageRole.USER, content: "" }],
        sessionId: "sess_deny",
        toolResults: [{ toolUseId: "tu_789", approved: false }],
      }),
    );

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
