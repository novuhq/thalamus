import OpenAI, { APIError, APIUserAbortError } from "openai";
import type {
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import {
  type DurabilityBackend,
  type DurableBackend,
  type EdgeObserver,
  isEdgeObserver,
  type SessionCheckpoint,
} from "../durable/types";
import { AbortedError, ThalamusError } from "../errors";
import { createSendResult } from "../send-result";
import {
  type McpServerConfig,
  OPENAI,
  type Provider,
  type RequestParams,
  type Response,
  type SendResult,
  type SessionEventsFactory,
  type SessionOptions,
  type StreamPart,
} from "../types";
import { LocalVault } from "../vault/local-vault";
import type {
  Credential,
  Vault,
  VaultOptions,
  VaultStore,
} from "../vault/vault.interface";
import { openaiTransformer } from "./openai.transformer";
import { mapError, mapEvent, ResponseAccumulator } from "./openai-parser";
import { createSigV4Fetch } from "./sigv4-fetch";

/**
 * SSE drops manifest as many error types (TypeError, ECONNRESET, socket hang up,
 * proxy timeouts, etc.) that can't be exhaustively listed. We invert the check:
 * only abort, application-level, and permanent API errors are terminal;
 * everything else is treated as a transient transport failure worth retrying.
 */
function isTransientStreamError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  if (err instanceof APIUserAbortError) return false;
  if (err instanceof ThalamusError) return false;
  if (err instanceof APIError && err.status >= 400 && err.status < 500) {
    return false;
  }
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
  durable?: DurableBackend;
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
  private readonly _recovered: Promise<void>;

  private get edgeObserver(): EdgeObserver | null {
    return this.config.durable && isEdgeObserver(this.config.durable)
      ? this.config.durable
      : null;
  }

  private get checkpointBackend(): DurabilityBackend | null {
    return this.config.durable && !isEdgeObserver(this.config.durable)
      ? this.config.durable
      : null;
  }

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
      if (isEdgeObserver(config.durable)) {
        this._recovered = this.recoverFromEdge().catch(() => {});
      } else {
        this.recoverActiveSessions().catch(() => {});
        this._recovered = Promise.resolve();
      }
    } else {
      this._recovered = Promise.resolve();
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
      {
        stream: true as const,
        ...(afterSequenceNumber >= 0
          ? { starting_after: afterSequenceNumber }
          : {}),
      },
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
    const backend = this.checkpointBackend;
    const input = this.buildInput(params);
    let lastSequenceNumber = -1;
    let responseId: string | undefined;
    let retries = 0;

    const createParams = {
      model: this.model,
      input,
      ...(this.instructions ? { instructions: this.instructions } : {}),
      ...(mcpTools ? { tools: mcpTools } : {}),
      ...sessionParams,
      ...params.providerOptions,
    };

    while (retries <= MAX_RECONNECT_RETRIES) {
      try {
        let rawStream: AsyncIterable<ResponseStreamEvent>;

        if (responseId) {
          rawStream = this.resumeObservation(
            responseId,
            lastSequenceNumber,
            signal,
          );
        } else {
          rawStream = await this.client.responses.create(
            {
              ...createParams,
              stream: true,
              ...(backend ? { background: true } : {}),
            } as ResponseCreateParamsStreaming,
            { signal },
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
          if (backend && responseId) {
            await backend.save({
              sessionId: acc.sessionId ?? responseId,
              provider: "openai",
              lastEventId: String(lastSequenceNumber),
              createdAt: Date.now(),
              metadata: { responseId },
            });
          }
        }

        if (backend && responseId) {
          await backend.remove(acc.sessionId ?? responseId);
        }
        yield { type: "finish", response: acc.toResponse() };
        return;
      } catch (err) {
        if (!isTransientStreamError(err, signal)) throw err;
        if (!responseId) throw err;

        retries++;
        if (retries > MAX_RECONNECT_RETRIES) throw err;
      }
    }
  }

  /**
   * Recovers sessions that were active before a process restart.
   * Fires onSessionEvents callbacks for missed events, then resumes live
   * observation for sessions that are still running.
   */
  private async recoverActiveSessions(): Promise<void> {
    const backend = this.checkpointBackend;
    const { onSessionEvents } = this.config;
    if (!backend || !onSessionEvents) return;

    const active = await backend.getActive();

    await Promise.allSettled(
      active.map(async (checkpoint) => {
        const responseId = checkpoint.metadata?.responseId;
        if (!responseId) {
          await backend.remove(checkpoint.sessionId);
          return;
        }

        try {
          const status = await this.getStatus(responseId);

          if (
            status === "cancelled" ||
            status === "failed" ||
            status === "incomplete"
          ) {
            await backend.remove(checkpoint.sessionId);
            return;
          }

          const callbacks = onSessionEvents(checkpoint.sessionId);
          const stream = this.recoverStream(checkpoint, responseId);
          const result = createSendResult(stream, callbacks, {
            autoStart: true,
          });
          result.response.catch(async (err) => {
            console.error(
              `[thalamus] recovery stream failed for ${checkpoint.sessionId}:`,
              err instanceof Error ? err.message : err,
            );
            await backend.remove(checkpoint.sessionId).catch(() => {});
          });
        } catch (err) {
          console.error(
            `[thalamus] recovery failed for ${checkpoint.sessionId}:`,
            err instanceof Error ? err.message : err,
          );
          await backend.remove(checkpoint.sessionId).catch(() => {});
        }
      }),
    );
  }

  /**
   * Generates a stream for a recovered session: resumes observation from the
   * last known sequence number, deduplicates, and checkpoints as it goes.
   * Requires the original response to have been created with `background: true`.
   */
  private async *recoverStream(
    checkpoint: SessionCheckpoint,
    responseId: string,
  ): AsyncIterable<StreamPart> {
    const { sessionId } = checkpoint;
    const backend = this.checkpointBackend;
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
          if (backend) {
            await backend.save({
              sessionId,
              provider: "openai",
              lastEventId: String(lastSequenceNumber),
              createdAt: Date.now(),
              metadata: { responseId },
            });
          }
        }

        if (backend) await backend.remove(sessionId);
        yield { type: "finish", response: acc.toResponse() };
        return;
      } catch (err) {
        if (!isTransientStreamError(err)) throw err;

        retries++;
        if (retries > MAX_RECONNECT_RETRIES) throw err;
      }
    }
  }

  /**
   * Recovers sessions via the edge observer path. Queries the edge for
   * active sessions and reconnects to each, flushing buffered events
   * through onSessionEvents callbacks.
   */
  private async recoverFromEdge(): Promise<void> {
    const observer = this.edgeObserver;
    const { onSessionEvents } = this.config;
    if (!observer || !onSessionEvents) return;

    const active = await observer.listActive();

    for (const responseId of active) {
      const callbacks = onSessionEvents(responseId);
      const stream = this.edgeRecoverStream(responseId);
      const result = createSendResult(stream, callbacks, { autoStart: true });
      result.response.catch((err) => {
        console.error(
          `[thalamus] edge recovery failed for ${responseId}:`,
          err instanceof Error ? err.message : err,
        );
      });
    }
  }

  private async *edgeRecoverStream(
    responseId: string,
  ): AsyncIterable<StreamPart> {
    const observer = this.edgeObserver!;
    const eventStream = observer.events(responseId);
    const acc = new ResponseAccumulator();
    acc.sessionId = responseId;
    let hasEvents = false;

    for await (const frame of eventStream) {
      if (!frame.data) continue;
      if (!hasEvents) {
        hasEvents = true;
        yield { type: "stream-start", sessionId: responseId };
      }
      const rawEvent = JSON.parse(frame.data) as ResponseStreamEvent;
      yield* mapEvent(rawEvent, acc);
    }

    // WS was rejected (another consumer is connected) — skip silently.
    if (!hasEvents) return;

    await observer.stop(responseId).catch(() => {});
    yield { type: "finish", response: acc.toResponse() };
  }

  /**
   * Edge observation: dispatch via background mode, SSE runs on the CF Agent,
   * events arrive via WebSocket.
   */
  private async *edgeObserve(
    params: RequestParams,
    sessionParams: Record<string, unknown>,
    mcpTools: Record<string, unknown>[] | undefined,
    signal?: AbortSignal,
  ): AsyncIterable<StreamPart> {
    await this._recovered;

    const observer = this.edgeObserver!;
    const input = this.buildInput(params);

    // Must use stream + background together: OpenAI only persists events for
    // later retrieval when the create call includes stream: true.
    const initStream = await this.client.responses.create(
      {
        model: this.model,
        input,
        stream: true,
        background: true,
        ...(this.instructions ? { instructions: this.instructions } : {}),
        ...(mcpTools ? { tools: mcpTools } : {}),
        ...sessionParams,
        ...params.providerOptions,
      } as ResponseCreateParamsStreaming,
      { signal },
    );

    // Drain until we have the responseId so the CF Worker can take over.
    let responseId: string | undefined;
    let lastSeqNo = -1;
    for await (const event of initStream as AsyncIterable<ResponseStreamEvent>) {
      if (
        "sequence_number" in event &&
        typeof event.sequence_number === "number"
      ) {
        lastSeqNo = event.sequence_number;
      }
      if (event.type === "response.created") {
        responseId = event.response.id;
        break;
      }
    }

    if (!responseId) {
      throw new ThalamusError(
        "edge observe: no responseId from initial stream",
        {
          provider: OPENAI,
          isRetryable: false,
        },
      );
    }

    const startingAfter = lastSeqNo >= 0 ? `&starting_after=${lastSeqNo}` : "";
    await observer.observe({
      sessionId: responseId,
      streamUrl: `${this.client.baseURL}/responses/${responseId}?stream=true${startingAfter}`,
      headers: {
        Authorization: `Bearer ${this.client.apiKey}`,
      },
    });

    const eventStream = observer.events(responseId);
    const acc = new ResponseAccumulator();
    for await (const frame of eventStream) {
      if (signal?.aborted) break;
      if (!frame.data) continue;
      const rawEvent = JSON.parse(frame.data) as ResponseStreamEvent;
      yield* mapEvent(rawEvent, acc);
    }

    await observer.stop(responseId).catch(() => {});
    yield { type: "finish", response: acc.toResponse() };
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

      if (this.edgeObserver) {
        yield* this.edgeObserve(params, sessionParams, mcpTools, signal);
      } else {
        yield* this.resilientDispatchAndObserve(
          params,
          sessionParams,
          mcpTools,
          signal,
        );
      }
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
