import Anthropic, { APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import type {
  BetaManagedAgentsAgentCustomToolUseEvent,
  BetaManagedAgentsAgentMCPToolResultEvent,
  BetaManagedAgentsAgentMCPToolUseEvent,
  BetaManagedAgentsAgentMessageEvent,
  BetaManagedAgentsAgentToolResultEvent,
  BetaManagedAgentsAgentToolUseEvent,
  BetaManagedAgentsEventParams,
  BetaManagedAgentsSessionErrorEvent,
  BetaManagedAgentsSessionStatusIdleEvent,
  BetaManagedAgentsSpanModelRequestEndEvent,
  BetaManagedAgentsStreamSessionEvents,
  BetaManagedAgentsUserCustomToolResultEventParams,
  BetaManagedAgentsUserMessageEventParams,
  BetaManagedAgentsUserToolConfirmationEventParams,
  EventSendParams,
} from "@anthropic-ai/sdk/resources/beta/sessions";
import type { SessionCreateParams } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import { AbortedError, SessionExpiredError, ThalamusError } from "../errors";
import { createSendResult } from "../send-result";
import {
  type ActionRequired,
  ANTHROPIC,
  type Provider,
  type RequestParams,
  type Response,
  type SendResult,
  type SessionEventsFactory,
  type SessionOptions,
  type StreamPart,
  type ToolResult,
  type Usage,
} from "../types";
import type { Vault, VaultOptions } from "../vault/vault.interface";
import { toContentBlocks } from "./anthropic.transformer";
import { AnthropicVault } from "./anthropic.vault";

type StopReason = BetaManagedAgentsSessionStatusIdleEvent["stop_reason"];

function mapStopReason(reason: StopReason): Response["finishReason"] {
  switch (reason.type) {
    case "end_turn":
      return "stop";
    case "requires_action":
      return "requires-action";
    case "retries_exhausted":
      return "error";
    default:
      return "other";
  }
}

function mapSessionError(raw: unknown): ThalamusError {
  const obj = raw as { message?: string; type?: string } | null;
  const msg = obj?.message ?? String(raw);
  const isAuth = obj?.type === "authentication_error";
  return new ThalamusError(msg, { provider: ANTHROPIC, isRetryable: !isAuth });
}

function mapStreamError(err: unknown, sessionId?: string): ThalamusError {
  if (err instanceof APIUserAbortError) {
    return new AbortedError({ provider: ANTHROPIC, sessionId, cause: err });
  }

  if (sessionId && err instanceof APIError) {
    const status = err.status;
    if (status === 404 || status === 410) {
      return new SessionExpiredError(
        `Session ${sessionId} has expired or been archived`,
        { provider: ANTHROPIC, sessionId, cause: err },
      );
    }
  }

  if (err instanceof ThalamusError) return err;

  return new ThalamusError(String(err), {
    provider: ANTHROPIC,
    isRetryable: false,
    cause: err,
  });
}

function buildSendEvents(
  params: RequestParams,
): BetaManagedAgentsEventParams[] {
  if (params.toolResults?.length) {
    return params.toolResults.map(toSessionEvent);
  }

  const event: BetaManagedAgentsUserMessageEventParams = {
    type: "user.message",
    content: params.messages.flatMap((msg) => toContentBlocks(msg.content)),
  };
  return [event];
}

function toSessionEvent(
  tr: ToolResult,
):
  | BetaManagedAgentsUserToolConfirmationEventParams
  | BetaManagedAgentsUserCustomToolResultEventParams {
  if (tr.approved !== undefined) {
    return {
      type: "user.tool_confirmation" as const,
      tool_use_id: tr.toolUseId,
      result: tr.approved ? ("allow" as const) : ("deny" as const),
    };
  }
  return {
    type: "user.custom_tool_result" as const,
    custom_tool_use_id: tr.toolUseId,
    content: [{ type: "text" as const, text: tr.output ?? "" }],
  };
}

class ResponseAccumulator {
  content = "";
  finishReason: Response["finishReason"] = "stop";
  usage: Usage | undefined;
  actionsRequired: ActionRequired[] = [];
  done = false;

  toResponse(sessionId: string): Response {
    return {
      content: this.content,
      sessionId,
      finishReason: this.finishReason,
      usage: this.usage,
      actionsRequired:
        this.actionsRequired.length > 0 ? this.actionsRequired : undefined,
    };
  }
}

function* mapEvent(
  event: BetaManagedAgentsStreamSessionEvents,
  acc: ResponseAccumulator,
): Generator<StreamPart> {
  switch (event.type) {
    // --- text streaming ---
    case "agent.message": {
      const e = event as BetaManagedAgentsAgentMessageEvent;
      for (const block of e.content) {
        if (block.type === "text") {
          acc.content += block.text;
          yield { type: "text-delta", text: block.text };
        }
      }
      break;
    }

    // --- reasoning / thinking ---
    case "agent.thinking": {
      yield { type: "thinking", text: "" };
      break;
    }

    // --- tool calls ---
    case "agent.tool_use": {
      const e = event as BetaManagedAgentsAgentToolUseEvent;
      yield {
        type: "tool-use-done",
        toolName: e.name,
        toolUseId: e.id,
        input: e.input,
        source: { type: "builtin" },
      };
      break;
    }
    case "agent.tool_result": {
      const e = event as BetaManagedAgentsAgentToolResultEvent;
      const output = e.content?.find((b) => b.type === "text");
      yield {
        type: "tool-use-result",
        toolUseId: e.tool_use_id,
        output: output?.type === "text" ? output.text : undefined,
        source: { type: "builtin" },
      };
      break;
    }
    case "agent.mcp_tool_use": {
      const e = event as BetaManagedAgentsAgentMCPToolUseEvent;
      yield {
        type: "tool-use-done",
        toolName: e.name,
        toolUseId: e.id,
        input: e.input,
        source: {
          type: "mcp",
          serverName: e.mcp_server_name ?? "",
        },
      };
      break;
    }
    case "agent.mcp_tool_result": {
      const e = event as BetaManagedAgentsAgentMCPToolResultEvent;
      const output = e.content?.find((b) => b.type === "text");
      yield {
        type: "tool-use-result",
        toolUseId: e.mcp_tool_use_id,
        output: output?.type === "text" ? output.text : undefined,
        source: {
          type: "mcp",
          serverName: "",
        },
      };
      break;
    }
    case "agent.custom_tool_use": {
      const e = event as BetaManagedAgentsAgentCustomToolUseEvent;
      acc.actionsRequired.push({
        type: "tool-confirmation",
        toolUseId: e.id,
        toolName: e.name,
        input: e.input as Record<string, unknown>,
      });
      acc.finishReason = "requires-action";
      break;
    }

    // --- lifecycle ---
    case "session.status_running": {
      yield { type: "status-change", status: "running" };
      break;
    }
    case "session.status_rescheduled": {
      yield { type: "status-change", status: "retrying" };
      break;
    }
    case "session.status_idle": {
      const e = event as BetaManagedAgentsSessionStatusIdleEvent;
      yield { type: "status-change", status: "idle" };
      acc.finishReason = mapStopReason(e.stop_reason);
      acc.done = true;
      break;
    }
    case "session.status_terminated": {
      throw new ThalamusError("Session terminated", {
        provider: ANTHROPIC,
        isRetryable: false,
      });
    }

    // --- error ---
    case "session.error": {
      const e = event as BetaManagedAgentsSessionErrorEvent;
      throw mapSessionError(e.error);
    }
    // --- usage ---
    case "span.model_request_end": {
      const e = event as BetaManagedAgentsSpanModelRequestEndEvent;
      if (e.model_usage) {
        acc.usage = {
          inputTokens: e.model_usage.input_tokens,
          outputTokens: e.model_usage.output_tokens,
          totalTokens: e.model_usage.input_tokens + e.model_usage.output_tokens,
        };
      }
      break;
    }

    // --- escape hatch for everything else ---
    default: {
      yield {
        type: "provider-event",
        provider: ANTHROPIC,
        event: event.type,
        data: event as unknown as Record<string, unknown>,
      };
      break;
    }
  }
}

export type AnthropicProviderConfig = {
  agentId: string;
  environmentId: string;
  onSessionEvents?: SessionEventsFactory;
} & (
  | { apiKey: string; awsRegion?: never; awsWorkspaceId?: never }
  | { awsRegion: string; awsWorkspaceId?: string; apiKey?: never }
);

async function createClient(
  config: AnthropicProviderConfig,
): Promise<Anthropic> {
  if ("awsRegion" in config && config.awsRegion) {
    const { AnthropicAws } = await import("@anthropic-ai/aws-sdk");
    return new AnthropicAws({
      awsRegion: config.awsRegion,
      workspaceId: config.awsWorkspaceId,
    }) as unknown as Anthropic;
  }

  return new Anthropic({ apiKey: config.apiKey });
}

class AnthropicProvider implements Provider {
  readonly provider = ANTHROPIC;
  readonly runtimeId: string;

  private client?: Anthropic;
  private readonly config: AnthropicProviderConfig;
  private readonly agentId: string;
  private readonly environmentId: string;

  constructor(config: AnthropicProviderConfig) {
    this.config = config;
    this.agentId = config.agentId;
    this.environmentId = config.environmentId;
    this.runtimeId = config.agentId;
  }

  private async getClient(): Promise<Anthropic> {
    this.client ??= await createClient(this.config);
    return this.client;
  }

  send(params: RequestParams): SendResult {
    const callbacks = this.config.onSessionEvents
      ? this.config.onSessionEvents(params.sessionId ?? "<<pending>>")
      : undefined;
    return createSendResult(this.runStream(params), callbacks, {
      autoStart: !!this.config.onSessionEvents,
    });
  }

  private async dispatch(
    client: Anthropic,
    sessionId: string,
    params: RequestParams,
    signal?: AbortSignal,
  ): Promise<void> {
    const events = buildSendEvents(params);
    const sendParams: EventSendParams = { events };
    await client.beta.sessions.events.send(sessionId, sendParams, { signal });
  }

  private async *observe(
    client: Anthropic,
    sessionId: string,
    signal?: AbortSignal,
  ): AsyncIterable<StreamPart> {
    const sseStream = await client.beta.sessions.events.stream(
      sessionId,
      undefined,
      { signal },
    );

    const acc = new ResponseAccumulator();
    for await (const rawEvent of sseStream) {
      yield* mapEvent(rawEvent as BetaManagedAgentsStreamSessionEvents, acc);
      if (acc.done) break;
    }

    const response = acc.toResponse(sessionId);
    yield { type: "finish", response };
  }

  private async *fetchMissedEvents(
    client: Anthropic,
    sessionId: string,
    pageCursor?: string,
  ): AsyncIterable<StreamPart> {
    const page = await client.beta.sessions.events.list(sessionId, {
      ...(pageCursor ? { page: pageCursor } : {}),
    });
    const acc = new ResponseAccumulator();
    for await (const event of page) {
      yield* mapEvent(event as BetaManagedAgentsStreamSessionEvents, acc);
      if (acc.done) break;
    }
  }

  private async getStatus(
    client: Anthropic,
    sessionId: string,
  ): Promise<string> {
    const session = await client.beta.sessions.retrieve(sessionId);
    return session.status;
  }

  private async *runStream(params: RequestParams): AsyncIterable<StreamPart> {
    try {
      const client = await this.getClient();
      const sessionId =
        params.sessionId ??
        (await this.createSession({
          vaultIds: params.vaultIds,
          providerOptions: params.providerOptions,
        }));

      yield { type: "stream-start", sessionId };

      const signal = params.abortSignal ?? undefined;

      // Open observation before dispatching to avoid race condition
      // (Anthropic docs: "Only events emitted after the stream is opened are delivered")
      const observation = this.observe(client, sessionId, signal);
      await this.dispatch(client, sessionId, params, signal);

      yield* observation;
    } catch (err) {
      const error = mapStreamError(err, params.sessionId);
      yield { type: "error", error };
    }
  }

  async createSession(options?: SessionOptions): Promise<string> {
    const client = await this.getClient();
    const params: SessionCreateParams = {
      agent: this.agentId,
      environment_id: this.environmentId,
      ...(options?.vaultIds?.length ? { vault_ids: options.vaultIds } : {}),
      ...options?.providerOptions,
    };
    const session = await client.beta.sessions.create(params);
    return session.id;
  }

  async endSession(_sessionId: string): Promise<void> {
    // Anthropic sessions are managed server-side; no explicit teardown needed.
  }

  async createVault(options: VaultOptions): Promise<Vault> {
    const client = await this.getClient();
    const result = await client.beta.vaults.create({
      display_name: options.name,
      metadata: options.metadata,
    });
    return new AnthropicVault(result.id, client, this.agentId);
  }

  async getVault(vaultId: string): Promise<Vault> {
    const client = await this.getClient();
    await client.beta.vaults.retrieve(vaultId);
    return new AnthropicVault(vaultId, client, this.agentId);
  }
}

export function createAnthropicProvider(
  config: AnthropicProviderConfig,
): Provider {
  return new AnthropicProvider(config);
}
