import OpenAI, { APIError, APIUserAbortError } from "openai";
import type {
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import type { CloudflareEdgeObserver } from "../durable/cloudflare";
import {
  type DurabilityBackend,
  type DurableBackend,
  type EdgeObserver,
  isEdgeObserver,
  type SerializedRequestParams,
  type SessionCheckpoint,
} from "../durable/types";
import {
  AbortedError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
  ThalamusError,
} from "../errors";
import {
  logErrorMessage,
  resolveLogger,
  type ThalamusLogger,
  type ThalamusLoggerInput,
} from "../logger";
import { createSendResult } from "../send-result";
import { SessionMutex } from "../session-turn-lock.js";
import {
  type McpServerConfig,
  OPENAI,
  type ProviderWebhookHandlerOptions,
  type RequestParams,
  type SendResult,
  type SessionEventsFactory,
  type SessionOptions,
  type StreamingProvider,
  type StreamPart,
  type WebhookProvider,
  type WebhookSendResult,
} from "../types";
import { LocalVault } from "../vault/local-vault";
import type {
  Credential,
  Vault,
  VaultOptions,
  VaultStore,
} from "../vault/vault.interface";
import type { WebhookHandler } from "../webhook/index";
import { createProviderWebhookHandler } from "../webhook/index";
import { openaiTransformer } from "./openai.transformer";
import { mapEvent, ResponseAccumulator } from "./openai-parser";
import { createSigV4Fetch } from "./sigv4-fetch";
import { toOpenAIToolResultOutput } from "./tool-result";

export function mapError(error: unknown, provider: string): Error {
  if (error instanceof APIUserAbortError) {
    return new AbortedError({ provider, cause: error });
  }

  const msg = error instanceof Error ? error.message : String(error);
  const code = error instanceof APIError ? (error.code ?? "") : "";
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
  logger?: ThalamusLoggerInput;
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

class OpenAIProvider {
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
  private readonly log: ThalamusLogger;
  private readonly turnLock = new SessionMutex();
  private sessionBootstrap: Promise<string> | null = null;

  private get edgeObserver(): CloudflareEdgeObserver | null {
    return this.config.durable && isEdgeObserver(this.config.durable)
      ? (this.config.durable as CloudflareEdgeObserver)
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
    this.log = resolveLogger(config.logger);

    if (
      config.durable &&
      config.onSessionEvents &&
      !isEdgeObserver(config.durable)
    ) {
      this.recoverActiveSessions().catch(() => {});
    }
  }

  send(params: RequestParams): SendResult | Promise<WebhookSendResult> {
    const runId = crypto.randomUUID();
    const turnId = params.turnId ?? crypto.randomUUID();
    if (this.edgeObserver) {
      return this.sendViaWebhook(params, runId, turnId);
    }

    const callbacks = this.onSessionEvents
      ? this.onSessionEvents({
          sessionId: params.sessionId ?? "<<pending>>",
          turnId,
          runId,
          metadata: {},
        })
      : undefined;

    const stream = params.toolResults?.length
      ? this.streamToolResults(params, runId)
      : this.streamWithLock(params, runId);

    return createSendResult(stream, runId, turnId, callbacks, {
      autoStart: !!this.onSessionEvents,
    });
  }

  private async sendViaWebhook(
    params: RequestParams,
    runId: string,
    turnId: string,
  ): Promise<WebhookSendResult> {
    this.log.info("send.start", {
      stage: "send.start",
      provider: OPENAI,
      mode: "webhook",
      sessionId: params.sessionId,
      runId,
      turnId,
    });

    const observer = this.edgeObserver!;
    const resolvedSessionId = await this.ensureSession(params);

    const serializedRequest: SerializedRequestParams = {
      messages: params.messages,
      sessionId: resolvedSessionId,
      toolResults: params.toolResults,
      vaultIds: params.vaultIds,
      providerOptions: params.providerOptions,
      webhookMetadata: params.webhookMetadata,
    };

    this.log.info("edge.enqueue", {
      stage: "edge.enqueue",
      provider: OPENAI,
      sessionId: resolvedSessionId,
      runId,
      turnId,
    });

    const enqueueStartedAt = Date.now();
    let enqueueResult: { status: "active" | "queued" };
    try {
      enqueueResult = await observer.enqueue({
        sessionId: resolvedSessionId,
        runId,
        turnId,
        provider: "openai",
        request: serializedRequest,
        webhook: {
          ...observer.webhook,
          metadata: params.webhookMetadata,
        },
      });
    } catch (err) {
      this.log.error("edge.enqueue.failed", {
        stage: "edge.enqueue.failed",
        provider: OPENAI,
        sessionId: resolvedSessionId,
        runId,
        error: logErrorMessage(err),
      });
      throw err;
    }

    if (enqueueResult.status === "active") {
      const sessionParams = this.resolveSessionParams(resolvedSessionId);
      const credentials = params.vaultIds?.length
        ? await this.resolveCredentials(params.vaultIds)
        : undefined;
      const mcpTools =
        this.mcpServers.length > 0
          ? toMcpTools(this.mcpServers, credentials)
          : undefined;
      const input = this.buildInput(params);

      await this.dispatchAndObserve(
        resolvedSessionId,
        runId,
        turnId,
        input,
        sessionParams,
        mcpTools,
        params.providerOptions,
        params.webhookMetadata,
      );
    }

    this.log.info("send.complete", {
      stage: "send.complete",
      provider: OPENAI,
      mode: "webhook",
      sessionId: resolvedSessionId,
      runId,
      turnId,
      durationMs: Date.now() - enqueueStartedAt,
    });

    return { sessionId: resolvedSessionId, runId, turnId };
  }

  private async dispatchAndObserve(
    sessionId: string,
    runId: string,
    turnId: string,
    input: ResponseInput,
    sessionParams: Record<string, unknown>,
    mcpTools: Record<string, unknown>[] | undefined,
    providerOptions: Record<string, unknown> | undefined,
    webhookMetadata: Record<string, string> | undefined,
  ): Promise<void> {
    const observer = this.edgeObserver!;

    const createParams = {
      model: this.model,
      input,
      ...(this.instructions ? { instructions: this.instructions } : {}),
      ...(mcpTools ? { tools: mcpTools } : {}),
      ...sessionParams,
      ...providerOptions,
    };

    const rawStream = await this.client.responses.create({
      ...createParams,
      stream: true,
      background: true,
    } as ResponseCreateParamsStreaming);

    let responseId: string | undefined;
    let lastSeqNo = -1;

    for await (const event of rawStream) {
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
        "Failed to obtain responseId from OpenAI stream",
        { provider: OPENAI, isRetryable: false },
      );
    }

    const streamUrl = `${this.client.baseURL}/responses/${responseId}?stream=true&starting_after=${lastSeqNo}`;

    await observer.observe({
      sessionId,
      runId,
      turnId,
      streamUrl,
      headers: {
        Authorization: `Bearer ${this.client.apiKey}`,
      },
      provider: "openai",
      webhook: {
        ...observer.webhook,
        metadata: webhookMetadata,
      },
    });
  }

  async dispatchQueued(
    sessionId: string,
    runId: string,
    turnId: string,
    request: SerializedRequestParams,
  ): Promise<void> {
    const sessionParams = this.resolveSessionParams(sessionId);
    const credentials = request.vaultIds?.length
      ? await this.resolveCredentials(request.vaultIds)
      : undefined;
    const mcpTools =
      this.mcpServers.length > 0
        ? toMcpTools(this.mcpServers, credentials)
        : undefined;
    const input = this.buildInput(request as RequestParams);

    await this.dispatchAndObserve(
      sessionId,
      runId,
      turnId,
      input,
      sessionParams,
      mcpTools,
      request.providerOptions,
      request.webhookMetadata,
    );
  }

  /**
   * Ensures a sessionId is available, deduplicating concurrent first-message calls.
   * For conversations mode, creates a conversation if needed via a shared promise
   * so concurrent sends don't each create their own session.
   */
  private async ensureSession(params: RequestParams): Promise<string> {
    if (params.sessionId) {
      if (this.sessionBootstrap) await this.sessionBootstrap;
      return params.sessionId;
    }

    if (!this.sessionBootstrap) {
      this.sessionBootstrap = this.createNewSession().finally(() => {
        this.sessionBootstrap = null;
      });
    }
    return this.sessionBootstrap;
  }

  private async createNewSession(): Promise<string> {
    if (!this.useConversations) {
      return crypto.randomUUID();
    }
    const conversation = await this.client.conversations.create();
    this.log.debug("conversation.create", {
      stage: "conversation.create",
      provider: OPENAI,
      sessionId: conversation.id,
    });
    return conversation.id;
  }

  private resolveSessionParams(sessionId: string): Record<string, unknown> {
    if (this.useConversations) {
      return { conversation: { id: sessionId } };
    }
    return { previous_response_id: sessionId };
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
          output: toOpenAIToolResultOutput(tr.content),
        };
      });
      input = [...toolInputs, ...input];
    }

    return input;
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
    runId: string,
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
    let dispatchSent = false;

    this.log.debug("dispatch.input", {
      stage: "dispatch.input",
      provider: OPENAI,
      runId,
      messageCount: params.messages.length,
      hasToolResults: Boolean(params.toolResults?.length),
    });

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
          this.log.debug("dispatch.start", {
            stage: "dispatch.start",
            provider: OPENAI,
            mode: "stream",
            runId,
          });
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
            if (!dispatchSent) {
              dispatchSent = true;
              this.log.info("dispatch.sent", {
                stage: "dispatch.sent",
                provider: OPENAI,
                mode: "stream",
                runId,
                sessionId: responseId,
              });
            }
          }
          yield* mapEvent(rawEvent, acc);
          if (backend && responseId) {
            await backend.save({
              sessionId: acc.sessionId ?? responseId,
              provider: "openai",
              lastEventId: String(lastSequenceNumber),
              createdAt: Date.now(),
              runId,
              metadata: { responseId },
            });
          }
        }

        if (backend && responseId) {
          await backend.remove(acc.sessionId ?? responseId);
        }
        this.log.info("send.complete", {
          stage: "send.complete",
          provider: OPENAI,
          mode: "stream",
          runId,
          sessionId: responseId ?? acc.sessionId,
        });
        yield { type: "finish", response: acc.toResponse() };
        return;
      } catch (err) {
        if (!isTransientStreamError(err, signal)) throw err;
        if (!responseId) throw err;

        retries++;
        if (retries > MAX_RECONNECT_RETRIES) throw err;

        this.log.warn("stream.reconnect", {
          stage: "stream.reconnect",
          provider: OPENAI,
          runId,
          sessionId: responseId,
          retry: retries,
          error: logErrorMessage(err),
        });
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
          this.log.error("recovery.failed", {
            stage: "recovery.failed",
            provider: OPENAI,
            sessionId: checkpoint.sessionId,
            runId: checkpoint.runId,
            error: "missing responseId in checkpoint metadata",
          });
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

          const { runId } = checkpoint;
          const recoveryTurnId = crypto.randomUUID();
          const callbacks = onSessionEvents({
            sessionId: checkpoint.sessionId,
            turnId: recoveryTurnId,
            runId,
            metadata: {},
          });
          const stream = this.recoverStream(checkpoint, runId, responseId);
          const result = createSendResult(
            stream,
            runId,
            recoveryTurnId,
            callbacks,
            { autoStart: true },
          );
          result.response.catch(async (err) => {
            this.log.error("recovery.stream.failed", {
              stage: "recovery.stream.failed",
              provider: OPENAI,
              sessionId: checkpoint.sessionId,
              runId,
              error: logErrorMessage(err),
            });
            await backend.remove(checkpoint.sessionId).catch(() => {});
          });
        } catch (err) {
          this.log.error("recovery.failed", {
            stage: "recovery.failed",
            provider: OPENAI,
            sessionId: checkpoint.sessionId,
            runId: checkpoint.runId,
            error: logErrorMessage(err),
          });
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
    runId: string,
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
              runId,
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

  private async *streamWithLock(
    params: RequestParams,
    runId: string,
  ): AsyncIterable<StreamPart> {
    let release: (() => void) | undefined;
    try {
      let sessionId: string;
      try {
        sessionId = await this.ensureSession(params);
      } catch (err) {
        const mapped =
          err instanceof ThalamusError ? err : (mapError(err, OPENAI) as Error);
        yield { type: "error", error: mapped };
        return;
      }

      if (params.sessionId) {
        yield { type: "status-change", status: "queued" };
      }

      release = await this.turnLock.acquire(sessionId, params.abortSignal);

      yield* this.withTurnRelease(
        this.runStream({ ...params, sessionId }, runId),
        release,
      );
    } catch (err) {
      release?.();
      throw err;
    }
  }

  /** toolResults bypass the queue — just stream and release the existing holder. */
  private async *streamToolResults(
    params: RequestParams,
    runId: string,
  ): AsyncIterable<StreamPart> {
    const sessionId = params.sessionId;
    const release = sessionId
      ? () => this.turnLock.release(sessionId)
      : undefined;

    try {
      yield* this.withTurnRelease(this.runStream(params, runId), release);
    } catch (err) {
      release?.();
      throw err;
    }
  }

  /** Forwards stream parts, releasing the lock when the turn ends.
   *  Uses try/finally so errors and aborts also release the lock. */
  private async *withTurnRelease(
    stream: AsyncIterable<StreamPart>,
    release: (() => void) | undefined,
  ): AsyncIterable<StreamPart> {
    let keepLock = false;
    try {
      for await (const part of stream) {
        if (part.type === "finish") {
          keepLock = part.response.finishReason === "requires-action";
        }
        yield part;
      }
    } finally {
      if (!keepLock) release?.();
    }
  }

  private async *runStream(
    params: RequestParams,
    runId: string,
  ): AsyncIterable<StreamPart> {
    this.log.info("send.start", {
      stage: "send.start",
      provider: OPENAI,
      mode: "stream",
      sessionId: params.sessionId,
      runId,
    });

    try {
      const sessionParams = params.sessionId
        ? this.resolveSessionParams(params.sessionId)
        : {};

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
        runId,
        sessionParams,
        mcpTools,
        signal,
      );
    } catch (err) {
      const mapped =
        err instanceof ThalamusError ? err : (mapError(err, OPENAI) as Error);
      this.log.error("stream.error", {
        stage: "stream.error",
        provider: OPENAI,
        mode: "stream",
        runId,
        sessionId: params.sessionId,
        error: logErrorMessage(mapped),
      });
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

  createWebhookHandler(options: ProviderWebhookHandlerOptions): WebhookHandler {
    return createProviderWebhookHandler(
      this.config.logger,
      this.config.onSessionEvents,
      {
        ...options,
        onQueueReady: (params) =>
          this.dispatchQueued(
            params.sessionId,
            params.runId,
            params.turnId,
            params.request,
          ),
      },
    );
  }
}

export function createOpenAIProvider(
  config: OpenAIProviderConfig & { durable: EdgeObserver },
): WebhookProvider;
export function createOpenAIProvider(
  config: OpenAIProviderConfig,
): StreamingProvider;
export function createOpenAIProvider(
  config: OpenAIProviderConfig,
): StreamingProvider | WebhookProvider {
  return new OpenAIProvider(config) as StreamingProvider | WebhookProvider;
}
