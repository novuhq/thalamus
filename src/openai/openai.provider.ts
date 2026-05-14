import OpenAI, { APIError, APIUserAbortError } from "openai";
import type {
  ResponseCreateParamsStreaming,
  ResponseErrorEvent,
  ResponseInput,
  ResponseMcpCallArgumentsDeltaEvent,
  ResponseOutputItem,
  ResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import type { DurabilityBackend, SessionCheckpoint } from "../durable/types";
import {
  AbortedError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
  ThalamusError,
} from "../errors";
import { createSendResult } from "../send-result";
import {
  type ActionRequired,
  type McpServerConfig,
  OPENAI,
  type Provider,
  type RequestParams,
  type Response,
  type SendResult,
  type SessionEventsFactory,
  type SessionOptions,
  type StreamPart,
  type Usage,
} from "../types";
import { LocalVault } from "../vault/local-vault";
import type {
  Credential,
  Vault,
  VaultOptions,
  VaultStore,
} from "../vault/vault.interface";
import { openaiTransformer } from "./openai.transformer";
import { createSigV4Fetch } from "./sigv4-fetch";

function isResponseErrorEvent(e: unknown): e is ResponseErrorEvent {
  return (
    typeof e === "object" &&
    e !== null &&
    "type" in e &&
    (e as ResponseErrorEvent).type === "error" &&
    "code" in e
  );
}

function mapError(error: unknown, provider: string): Error {
  if (error instanceof APIUserAbortError) {
    return new AbortedError({ provider, cause: error });
  }

  const msg = error instanceof Error ? error.message : String(error);
  const code =
    error instanceof APIError
      ? (error.code ?? "")
      : isResponseErrorEvent(error)
        ? (error.code ?? "")
        : "";
  if (
    code === "invalid_api_key" ||
    msg.toLowerCase().includes("unauthorized")
  ) {
    return new ProviderAuthError(msg, { provider, cause: error });
  }
  if (
    code === "rate_limit_exceeded" ||
    msg.toLowerCase().includes("rate limit")
  ) {
    return new ProviderRateLimitError(msg, { provider, cause: error });
  }
  if (
    msg.toLowerCase().includes("unavailable") ||
    msg.toLowerCase().includes("503")
  ) {
    return new ProviderUnavailableError(msg, { provider, cause: error });
  }
  return new ProviderResponseError(msg, { provider, cause: error });
}

/**
 * SSE drops manifest as many error types (TypeError, ECONNRESET, socket hang up,
 * proxy timeouts, etc.) that can't be exhaustively listed. We invert the check:
 * only abort and application-level errors are terminal; everything else is
 * treated as a transient transport failure worth retrying.
 */
function isTransientStreamError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  if (err instanceof APIUserAbortError) return false;
  if (err instanceof ThalamusError) return false;
  return true;
}

type OpenAIDirectConfig = {
  apiKey: string;
  awsRegion?: never;
  awsBedrockApiKey?: never;
  awsCredentials?: never;
};

type OpenAIBedrockApiKeyConfig = {
  awsRegion: string;
  awsBedrockApiKey: string;
  apiKey?: never;
  awsCredentials?: never;
};

type OpenAIBedrockSigV4Config = {
  awsRegion: string;
  awsCredentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  apiKey?: never;
  awsBedrockApiKey?: never;
};

type OpenAIBaseConfig = {
  model?: string;
  promptId?: string;
  instructions?: string;
  mcpServers?: McpServerConfig[];
  vaultStore?: VaultStore;
  onSessionEvents?: SessionEventsFactory;
  durable?: DurabilityBackend;
};

function mapApprovalPolicy(policy: McpServerConfig["approvalPolicy"]): unknown {
  if (!policy || typeof policy === "string") return policy;
  return { never: { tool_names: policy.except } };
}

// OpenAI SDK (v6.37) doesn't export MCP tool types yet — using untyped records
// matching the wire format from https://developers.openai.com/docs/guides/tools-connectors-mcp
function toMcpTools(
  servers: McpServerConfig[],
  credentials?: Map<string, Credential>,
): Record<string, unknown>[] {
  return servers.map((server) => {
    const tool: Record<string, unknown> = {
      type: "mcp",
      server_label: server.name,
      server_url: server.url,
    };

    // Vault credential takes priority over static server.authorization
    const cred = credentials?.get(server.name);
    if (cred) {
      tool.authorization =
        cred.type === "bearer" ? cred.token : cred.accessToken;
    } else if (server.authorization) {
      tool.authorization = server.authorization;
    }

    if (server.allowedTools) {
      tool.allowed_tools = server.allowedTools;
    }
    if (server.approvalPolicy) {
      tool.require_approval = mapApprovalPolicy(server.approvalPolicy);
    }
    return tool;
  });
}

const MAX_RECONNECT_RETRIES = 3;

export type OpenAIProviderConfig = OpenAIBaseConfig &
  (OpenAIDirectConfig | OpenAIBedrockApiKeyConfig | OpenAIBedrockSigV4Config);

class ResponseAccumulator {
  content = "";
  sessionId: string | undefined;
  conversationId: string | undefined;
  finishReason: Response["finishReason"] = "stop";
  usage: Usage | undefined;
  actionsRequired: ActionRequired[] = [];

  toResponse(): Response {
    return {
      content: this.content,
      sessionId: this.conversationId ?? this.sessionId,
      finishReason: this.finishReason,
      usage: this.usage,
      actionsRequired:
        this.actionsRequired.length > 0 ? this.actionsRequired : undefined,
    };
  }
}

function* mapEvent(
  event: ResponseStreamEvent,
  acc: ResponseAccumulator,
): Generator<StreamPart> {
  switch (event.type) {
    // --- lifecycle ---
    case "response.created": {
      acc.sessionId = event.response.id;
      acc.conversationId = event.response.conversation?.id;
      yield {
        type: "stream-start",
        sessionId: acc.conversationId ?? acc.sessionId,
      };
      break;
    }
    case "response.in_progress": {
      yield { type: "status-change", status: "running" };
      break;
    }
    case "response.completed": {
      if (event.response.usage) {
        acc.usage = {
          inputTokens: event.response.usage.input_tokens,
          outputTokens: event.response.usage.output_tokens,
          totalTokens: event.response.usage.total_tokens,
        };
      }
      if (!acc.content) {
        acc.content = event.response.output_text;
      }
      break;
    }
    case "response.failed": {
      acc.finishReason = "error";
      throw new ThalamusError(
        event.response.error?.message ?? "Response failed",
        { provider: OPENAI, isRetryable: false },
      );
    }
    case "response.incomplete": {
      acc.finishReason = "length";
      break;
    }

    // --- text streaming ---
    case "response.output_text.delta": {
      acc.content += event.delta;
      yield { type: "text-delta", text: event.delta };
      break;
    }

    // --- refusal ---
    case "response.refusal.delta": {
      acc.finishReason = "refused";
      yield { type: "refusal", text: event.delta };
      break;
    }

    // --- reasoning / thinking ---
    case "response.reasoning_summary_text.delta": {
      yield { type: "thinking", text: event.delta };
      break;
    }

    // --- function / tool calls ---
    case "response.output_item.added": {
      const e = event as ResponseOutputItemAddedEvent;
      if (e.item.type === "function_call") {
        yield {
          type: "tool-use-start",
          toolName: e.item.name,
          toolUseId: e.item.call_id,
          source: { type: "builtin" },
        };
      } else if (e.item.type === "mcp_call") {
        const item = e.item as ResponseOutputItem.McpCall;
        yield {
          type: "tool-use-start",
          toolName: item.name,
          toolUseId: item.id,
          source: { type: "mcp", serverName: item.server_label },
        };
      }
      break;
    }
    case "response.function_call_arguments.delta": {
      yield {
        type: "tool-use-delta",
        toolUseId: event.item_id,
        argumentsDelta: event.delta,
      };
      break;
    }
    case "response.mcp_call_arguments.delta": {
      const e = event as ResponseMcpCallArgumentsDeltaEvent;
      yield {
        type: "tool-use-delta",
        toolUseId: e.item_id,
        argumentsDelta: e.delta,
      };
      break;
    }
    case "response.output_item.done": {
      const e = event as ResponseOutputItemDoneEvent;
      if (e.item.type === "function_call") {
        yield {
          type: "tool-use-done",
          toolName: e.item.name,
          toolUseId: e.item.call_id,
          input: JSON.parse(e.item.arguments || "{}"),
          source: { type: "builtin" },
        };
      } else if (e.item.type === "mcp_list_tools") {
        const item = e.item as ResponseOutputItem.McpListTools;
        yield {
          type: "mcp-tools-discovered",
          serverName: item.server_label,
          tools: (item.tools ?? []).map((t) => ({
            name: t.name,
            description: t.description ?? undefined,
            inputSchema: t.input_schema as Record<string, unknown> | undefined,
          })),
        };
      } else if (e.item.type === "mcp_call") {
        const item = e.item as ResponseOutputItem.McpCall;
        yield {
          type: "tool-use-done",
          toolName: item.name,
          toolUseId: item.id,
          input: JSON.parse(item.arguments || "{}"),
          source: { type: "mcp", serverName: item.server_label },
        };
        yield {
          type: "tool-use-result",
          toolUseId: item.id,
          output: item.output ?? undefined,
          source: { type: "mcp", serverName: item.server_label },
        };
      } else if (e.item.type === "mcp_approval_request") {
        const item = e.item as ResponseOutputItem.McpApprovalRequest;
        acc.finishReason = "requires-action";
        acc.actionsRequired.push({
          type: "mcp-approval",
          toolUseId: item.id,
          toolName: item.name,
          serverName: item.server_label,
          input: JSON.parse(item.arguments || "{}"),
        });
      }
      break;
    }

    // --- error ---
    case "error": {
      throw mapError(event, OPENAI);
    }

    // --- escape hatch for everything else ---
    default: {
      yield {
        type: "provider-event",
        provider: OPENAI,
        event: event.type,
        data: event as unknown as Record<string, unknown>,
      };
      break;
    }
  }
}

function buildOpenAIClient(config: OpenAIProviderConfig): OpenAI {
  if (!("awsRegion" in config) || !config.awsRegion) {
    return new OpenAI({ apiKey: config.apiKey });
  }

  const baseURL = `https://bedrock-mantle.${config.awsRegion}.api.aws/v1`;

  if ("awsBedrockApiKey" in config && config.awsBedrockApiKey) {
    return new OpenAI({ baseURL, apiKey: config.awsBedrockApiKey });
  }

  if ("awsCredentials" in config && config.awsCredentials) {
    return new OpenAI({
      baseURL,
      apiKey: "bedrock-sigv4",
      fetch: createSigV4Fetch({
        region: config.awsRegion,
        credentials: config.awsCredentials,
      }),
    });
  }

  return new OpenAI({ baseURL, apiKey: "bedrock" });
}

class OpenAIProvider implements Provider {
  readonly provider = OPENAI;
  readonly runtimeId: string;

  private readonly client: OpenAI;
  private readonly model: string;
  private readonly instructions?: string;
  private readonly useConversations: boolean;
  private readonly mcpServers: McpServerConfig[];
  private readonly vaultStore?: VaultStore;
  private readonly onSessionEvents?: SessionEventsFactory;
  private readonly config: OpenAIProviderConfig;

  constructor(config: OpenAIProviderConfig) {
    this.config = config;
    this.runtimeId = config.promptId ?? "inline";
    this.model = config.model ?? "gpt-4o";
    this.instructions = config.instructions;
    this.client = buildOpenAIClient(config);
    this.useConversations = !("awsRegion" in config && config.awsRegion);
    this.mcpServers = config.mcpServers ?? [];
    this.vaultStore = config.vaultStore;
    this.onSessionEvents = config.onSessionEvents;

    if (config.durable && config.onSessionEvents) {
      this.recoverActiveSessions().catch(() => {});
    }
  }

  send(params: RequestParams): SendResult {
    const callbacks = this.onSessionEvents
      ? this.onSessionEvents(params.sessionId ?? "<<pending>>")
      : undefined;
    return createSendResult(this.runStream(params), callbacks, {
      autoStart: !!this.onSessionEvents,
    });
  }

  private async resolveSessionParams(
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.useConversations) {
      const id = sessionId ?? (await this.client.conversations.create()).id;
      return { conversation: { id } };
    }
    return sessionId ? { previous_response_id: sessionId } : {};
  }

  private buildInput(params: RequestParams): ResponseInput {
    let input: ResponseInput = openaiTransformer.toInput(
      params.messages,
    ) as ResponseInput;

    if (params.toolResults?.length) {
      const toolInputs: ResponseInput = params.toolResults.map((tr) => {
        if (tr.approved !== undefined) {
          return {
            type: "mcp_approval_response" as const,
            approval_request_id: tr.toolUseId,
            approve: tr.approved,
          };
        }
        return {
          type: "function_call_output" as const,
          call_id: tr.toolUseId,
          output: tr.output ?? "",
        };
      });
      input = [...toolInputs, ...input];
    }

    return input;
  }

  private async *dispatchAndObserve(
    params: RequestParams,
    sessionParams: Record<string, unknown>,
    mcpTools: Record<string, unknown>[] | undefined,
    signal?: AbortSignal,
  ): AsyncIterable<StreamPart> {
    const input = this.buildInput(params);

    const rawStream = await this.client.responses.create(
      {
        model: this.model,
        input,
        stream: true,
        ...(this.instructions ? { instructions: this.instructions } : {}),
        ...(mcpTools ? { tools: mcpTools } : {}),
        ...sessionParams,
        ...params.providerOptions,
      } as ResponseCreateParamsStreaming,
      { signal },
    );

    const acc = new ResponseAccumulator();
    for await (const rawEvent of rawStream) {
      yield* mapEvent(rawEvent, acc);
    }

    const response = acc.toResponse();
    yield { type: "finish", response };
  }

  private async *resumeObservation(
    responseId: string,
    afterSequenceNumber: number,
    signal?: AbortSignal,
  ): AsyncIterable<ResponseStreamEvent> {
    const rawStream = (await this.client.responses.retrieve(
      responseId,
      { stream: true as const, starting_after: afterSequenceNumber },
      { signal },
    )) as AsyncIterable<ResponseStreamEvent>;

    yield* rawStream;
  }

  private async getStatus(responseId: string): Promise<string | undefined> {
    const response = await this.client.responses.retrieve(responseId);
    return response.status;
  }

  /**
   * Wraps dispatch+observe with auto-reconnect on transient network failures.
   * OpenAI combines dispatch and observe in a single responses.create() call,
   * so the first attempt dispatches; retries resume via responses.retrieve()
   * with starting_after (cursor-based, no event duplication from the API).
   *
   * Dedup by sequence_number guards against overlapping events if the API
   * sends a partial replay on resume.
   */
  private async *resilientDispatchAndObserve(
    params: RequestParams,
    sessionParams: Record<string, unknown>,
    mcpTools: Record<string, unknown>[] | undefined,
    signal?: AbortSignal,
  ): AsyncIterable<StreamPart> {
    const acc = new ResponseAccumulator();
    const durable = this.config.durable;
    let lastSequenceNumber = -1;
    let responseId: string | undefined;
    let retries = 0;
    let dispatched = false;

    while (retries <= MAX_RECONNECT_RETRIES) {
      try {
        let rawStream: AsyncIterable<ResponseStreamEvent>;

        if (!dispatched) {
          const input = this.buildInput(params);
          rawStream = await this.client.responses.create(
            {
              model: this.model,
              input,
              stream: true,
              ...(this.instructions ? { instructions: this.instructions } : {}),
              ...(mcpTools ? { tools: mcpTools } : {}),
              ...sessionParams,
              ...params.providerOptions,
            } as ResponseCreateParamsStreaming,
            { signal },
          );
          dispatched = true;
        } else {
          rawStream = this.resumeObservation(
            responseId!,
            lastSequenceNumber,
            signal,
          );
        }

        for await (const rawEvent of rawStream) {
          if (
            "sequence_number" in rawEvent &&
            typeof rawEvent.sequence_number === "number"
          ) {
            if (rawEvent.sequence_number <= lastSequenceNumber) continue;
            lastSequenceNumber = rawEvent.sequence_number;
          }
          if (rawEvent.type === "response.created") {
            responseId = rawEvent.response.id;
          }
          yield* mapEvent(rawEvent, acc);
          if (durable && responseId) {
            await durable.save({
              sessionId: acc.sessionId ?? responseId,
              provider: "openai",
              lastEventId: String(lastSequenceNumber),
              createdAt: Date.now(),
              metadata: { responseId },
            });
          }
        }

        if (durable && responseId) {
          await durable.remove(acc.sessionId ?? responseId);
        }
        yield { type: "finish", response: acc.toResponse() };
        return;
      } catch (err) {
        if (!isTransientStreamError(err, signal)) throw err;
        if (!responseId || !dispatched) throw err;

        retries++;
        if (retries > MAX_RECONNECT_RETRIES) throw err;
      }
    }
  }

  /**
   * Best-effort recovery of sessions that were active before a process restart.
   * Fires onSessionEvents callbacks for missed events, then resumes live
   * observation for sessions that are still running.
   */
  private async recoverActiveSessions(): Promise<void> {
    const { durable, onSessionEvents } = this.config;
    if (!durable || !onSessionEvents) return;

    const active = await durable.getActive();

    await Promise.allSettled(
      active.map(async (checkpoint) => {
        const responseId = checkpoint.metadata?.responseId;
        if (!responseId) {
          await durable.remove(checkpoint.sessionId);
          return;
        }

        try {
          const status = await this.getStatus(responseId);

          if (status === "in_progress" || status === "completed") {
            const callbacks = onSessionEvents(checkpoint.sessionId);
            const stream = this.recoverStream(checkpoint, responseId);
            createSendResult(stream, callbacks, { autoStart: true });
          } else {
            await durable.remove(checkpoint.sessionId);
          }
        } catch {
          await durable.remove(checkpoint.sessionId).catch(() => {});
        }
      }),
    );
  }

  /**
   * Generates a stream for a recovered session: resumes observation from the
   * last known sequence number, deduplicates, and checkpoints as it goes.
   */
  private async *recoverStream(
    checkpoint: SessionCheckpoint,
    responseId: string,
  ): AsyncIterable<StreamPart> {
    const { sessionId } = checkpoint;
    const durable = this.config.durable;
    const acc = new ResponseAccumulator();
    let lastSequenceNumber = Number(checkpoint.lastEventId) || -1;
    let retries = 0;

    yield { type: "stream-start", sessionId };

    while (retries <= MAX_RECONNECT_RETRIES) {
      try {
        const rawStream = this.resumeObservation(
          responseId,
          lastSequenceNumber,
        );

        for await (const rawEvent of rawStream) {
          if (
            "sequence_number" in rawEvent &&
            typeof rawEvent.sequence_number === "number"
          ) {
            if (rawEvent.sequence_number <= lastSequenceNumber) continue;
            lastSequenceNumber = rawEvent.sequence_number;
          }
          yield* mapEvent(rawEvent, acc);
          if (durable) {
            await durable.save({
              sessionId,
              provider: "openai",
              lastEventId: String(lastSequenceNumber),
              createdAt: Date.now(),
              metadata: { responseId },
            });
          }
        }

        if (durable) await durable.remove(sessionId);
        yield { type: "finish", response: acc.toResponse() };
        return;
      } catch (err) {
        if (!isTransientStreamError(err)) throw err;

        retries++;
        if (retries > MAX_RECONNECT_RETRIES) throw err;
      }
    }
  }

  private async *runStream(params: RequestParams): AsyncIterable<StreamPart> {
    try {
      const sessionParams = await this.resolveSessionParams(params.sessionId);

      const credentials = params.vaultIds?.length
        ? await this.resolveCredentials(params.vaultIds)
        : undefined;

      const mcpTools =
        this.mcpServers.length > 0
          ? toMcpTools(this.mcpServers, credentials)
          : undefined;

      const signal = params.abortSignal ?? undefined;

      yield* this.resilientDispatchAndObserve(
        params,
        sessionParams,
        mcpTools,
        signal,
      );
    } catch (err) {
      const mapped =
        err instanceof ThalamusError ? err : (mapError(err, OPENAI) as Error);
      yield { type: "error", error: mapped };
    }
  }

  async createVault(options: VaultOptions): Promise<Vault> {
    if (!this.vaultStore) {
      throw new ThalamusError(
        "Pass a vaultStore to createOpenAIProvider() to use vault operations",
        {
          provider: OPENAI,
          isRetryable: false,
        },
      );
    }
    const record = await this.vaultStore.createVault(options);
    return new LocalVault(record.id, OPENAI, this.vaultStore);
  }

  async getVault(vaultId: string): Promise<Vault> {
    if (!this.vaultStore) {
      throw new ThalamusError(
        "vaultStore is required for OpenAI vault support",
        {
          provider: OPENAI,
          isRetryable: false,
        },
      );
    }
    const record = await this.vaultStore.getVault(vaultId);
    if (!record) {
      throw new ThalamusError(`Vault not found: ${vaultId}`, {
        provider: OPENAI,
        isRetryable: false,
      });
    }
    return new LocalVault(record.id, OPENAI, this.vaultStore);
  }

  private async resolveCredentials(
    vaultIds: string[],
  ): Promise<Map<string, Credential>> {
    if (!this.vaultStore) {
      throw new ThalamusError(
        "vaultStore is required to resolve vault credentials",
        { provider: OPENAI, isRetryable: false },
      );
    }
    const merged = new Map<string, Credential>();
    for (const vid of vaultIds) {
      const stored = await this.vaultStore.getAll(vid);
      for (const s of stored) {
        if (!merged.has(s.name)) {
          merged.set(s.name, s.credential);
        }
      }
    }
    return merged;
  }

  async createSession(_options?: SessionOptions): Promise<string> {
    return crypto.randomUUID();
  }

  async endSession(_sessionId: string): Promise<void> {
    // No-op for stateless provider.
  }
}

export function createOpenAIProvider(config: OpenAIProviderConfig): Provider {
  return new OpenAIProvider(config);
}
