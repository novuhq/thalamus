import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaManagedAgentsAgentCustomToolUseEvent,
  BetaManagedAgentsAgentMCPToolResultEvent,
  BetaManagedAgentsAgentMCPToolUseEvent,
  BetaManagedAgentsAgentMessageEvent,
  BetaManagedAgentsAgentToolResultEvent,
  BetaManagedAgentsAgentToolUseEvent,
  BetaManagedAgentsSessionErrorEvent,
  BetaManagedAgentsSessionStatusIdleEvent,
  BetaManagedAgentsSpanModelRequestEndEvent,
  BetaManagedAgentsStreamSessionEvents,
} from "@anthropic-ai/sdk/resources/beta/sessions";
import { SessionExpiredError, ThalamusError } from "../errors";
import { collectStream } from "../stream-utils";
import {
  type ActionRequired,
  ANTHROPIC,
  type Provider,
  type RequestParams,
  type Response,
  type StreamPart,
  type StreamResult,
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
  if (sessionId && err instanceof Error && "status" in err) {
    const status = (err as any).status;
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
          serverName: (e as any).server_name ?? "",
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
          serverName: (e as any).server_name ?? "",
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

  async send(params: RequestParams): Promise<Response> {
    return collectStream(await this.stream(params));
  }

  async stream(params: RequestParams): Promise<StreamResult> {
    let resolveResponse!: (r: Response) => void;
    let rejectResponse!: (e: unknown) => void;
    const responsePromise = new Promise<Response>((res, rej) => {
      resolveResponse = res;
      rejectResponse = rej;
    });
    return {
      stream: this.runStream(params, resolveResponse, rejectResponse),
      response: responsePromise,
    };
  }

  private async *runStream(
    params: RequestParams,
    resolveResponse: (r: Response) => void,
    rejectResponse: (e: unknown) => void,
  ): AsyncIterable<StreamPart> {
    try {
      const client = await this.getClient();
      const sessionId =
        params.sessionId ??
        (await this.createSession(client, params.providerOptions));

      yield { type: "stream-start", sessionId };

      const sseStream = await client.beta.sessions.events.stream(sessionId);
      await client.beta.sessions.events.send(sessionId, {
        events: [
          {
            type: "user.message" as const,
            content: params.messages.flatMap((msg) =>
              toContentBlocks(msg.content),
            ),
          },
        ],
      });

      const acc = new ResponseAccumulator();

      for await (const rawEvent of sseStream) {
        yield* mapEvent(rawEvent as BetaManagedAgentsStreamSessionEvents, acc);
        if (acc.done) break;
      }

      const response = acc.toResponse(sessionId);
      yield { type: "finish", response };
      resolveResponse(response);
    } catch (err) {
      const error = mapStreamError(err, params.sessionId);
      yield { type: "error", error };
      rejectResponse(error);
    }
  }

  private async createSession(
    client: Anthropic,
    providerOptions?: Record<string, unknown>,
  ): Promise<string> {
    const session = await client.beta.sessions.create({
      agent: this.agentId,
      environment_id: this.environmentId,
      ...providerOptions,
    });

    return session.id;
  }

  async createVault(options: VaultOptions): Promise<Vault> {
    const client = await this.getClient();
    const result = await (client.beta as any).vaults.create({
      display_name: options.name,
      metadata: options.metadata,
    });
    return new AnthropicVault(result.id, client);
  }

  async getVault(vaultId: string): Promise<Vault> {
    const client = await this.getClient();
    await (client.beta as any).vaults.retrieve(vaultId);
    return new AnthropicVault(vaultId, client);
  }
}

export function createAnthropicProvider(
  config: AnthropicProviderConfig,
): Provider {
  return new AnthropicProvider(config);
}
