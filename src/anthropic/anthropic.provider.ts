import Anthropic, { APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import type {
  BetaManagedAgentsStreamSessionEvents,
  BetaManagedAgentsUserCustomToolResultEventParams,
  BetaManagedAgentsUserToolConfirmationEventParams,
  EventSendParams,
} from "@anthropic-ai/sdk/resources/beta/sessions";
import type { SessionCreateParams } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import type { CloudflareEdgeObserver } from "../durable/cloudflare";
import { sanitizeAgentForSerialization } from "../durable/serialize-agent";
import {
  type DurabilityBackend,
  type DurableBackend,
  type EdgeEnqueueParams,
  type EdgeObserveParams,
  type EdgeObserver,
  isEdgeObserver,
  type SerializedRequestParams,
  type SessionCheckpoint,
} from "../durable/types";
import { AbortedError, SessionExpiredError, ThalamusError } from "../errors";
import {
  logErrorMessage,
  resolveLogger,
  type ThalamusLogger,
  type ThalamusLoggerInput,
} from "../logger";
import { createSendResult } from "../send-result";
import { SessionMutex } from "../session-turn-lock.js";
import {
  type AgentSessionConfig,
  ANTHROPIC,
  type ProviderWebhookHandlerOptions,
  type RequestParams,
  type SendResult,
  type SessionEventsFactory,
  type SessionOptions,
  type StreamingProvider,
  type StreamPart,
  type ToolResult,
  type WebhookProvider,
  type WebhookSendResult,
} from "../types";
import type { Vault, VaultOptions } from "../vault/vault.interface";
import type { WebhookHandler } from "../webhook/index";
import { createProviderWebhookHandler } from "../webhook/index";
import { buildSendEvents } from "./anthropic.transformer";
import { AnthropicVault } from "./anthropic.vault";
import { mapEvent, ResponseAccumulator } from "./anthropic-parser";
import { buildSessionAgentUpdate } from "./session-overrides";
import { toAnthropicToolResultContent } from "./tool-result";

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
    content: toAnthropicToolResultContent(tr.content),
  };
}

type AnthropicDirectConfig = {
  apiKey: string;
  awsRegion?: never;
  awsWorkspaceId?: never;
};

type AnthropicAwsApiKeyConfig = {
  awsRegion: string;
  awsWorkspaceId?: string;
  apiKey: string;
};

type AnthropicBaseConfig = {
  agentId: string;
  environmentId: string;
  onSessionEvents?: SessionEventsFactory;
  durable?: DurableBackend;
  logger?: ThalamusLoggerInput;
};

export type AnthropicProviderConfig = AnthropicBaseConfig &
  (AnthropicDirectConfig | AnthropicAwsApiKeyConfig);

async function createClient(
  config: AnthropicProviderConfig,
): Promise<Anthropic> {
  if ("awsRegion" in config) {
    if (!config.awsRegion?.trim()) {
      throw new Error("AWS Anthropic provider requires a non-empty awsRegion");
    }

    if (!config.apiKey?.trim()) {
      throw new Error(
        "AWS Anthropic provider requires apiKey when awsRegion is set",
      );
    }

    const { AnthropicAws } = await import("@anthropic-ai/aws-sdk");

    return new AnthropicAws({
      awsRegion: config.awsRegion,
      workspaceId: config.awsWorkspaceId,
      apiKey: config.apiKey,
    }) as unknown as Anthropic;
  }

  return new Anthropic({ apiKey: config.apiKey });
}

const MAX_RECONNECT_RETRIES = 3;

class AnthropicProvider {
  readonly provider = ANTHROPIC;
  readonly runtimeId: string;

  private client?: Anthropic;
  private readonly config: AnthropicProviderConfig;
  private readonly agentId: string;
  private readonly environmentId: string;
  private readonly log: ThalamusLogger;
  private readonly turnLock = new SessionMutex();
  /** While set, a new session is being created and its turn lock is being acquired. */
  private sessionBootstrap: Promise<string> | null = null;

  constructor(config: AnthropicProviderConfig) {
    this.config = config;
    this.agentId = config.agentId;
    this.environmentId = config.environmentId;
    this.runtimeId = config.agentId;
    this.log = resolveLogger(config.logger);

    if (
      config.durable &&
      config.onSessionEvents &&
      !isEdgeObserver(config.durable)
    ) {
      this.recoverActiveSessions().catch(() => {});
    }
  }

  private async getClient(): Promise<Anthropic> {
    this.client ??= await createClient(this.config);
    return this.client;
  }

  send(params: RequestParams): SendResult | Promise<WebhookSendResult> {
    const runId = crypto.randomUUID();
    const turnId = params.turnId ?? crypto.randomUUID();

    if (this.edgeObserver) {
      return this.sendViaWebhook(params, runId, turnId);
    }

    const callbacks = this.config.onSessionEvents
      ? this.config.onSessionEvents({
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
      autoStart: !!this.config.onSessionEvents,
    });
  }

  /**
   * Ensures a sessionId is available, deduplicating concurrent first-message calls.
   * If params already has a sessionId, returns it (after any in-flight bootstrap settles).
   * Otherwise creates a new session via a shared promise so concurrent sends
   * don't each create their own session.
   */
  private async ensureSession(params: RequestParams): Promise<string> {
    if (params.sessionId) {
      if (this.sessionBootstrap) await this.sessionBootstrap;
      return params.sessionId;
    }

    if (!this.sessionBootstrap) {
      this.sessionBootstrap = this.createNewSession(params).finally(() => {
        this.sessionBootstrap = null;
      });
    }
    return this.sessionBootstrap;
  }

  private async createNewSession(params: RequestParams): Promise<string> {
    await this.getClient();
    return this.createSession({
      vaultIds: params.vaultIds,
      providerOptions: params.providerOptions,
    });
  }

  /**
   * Main streaming path for new messages (with or without an existing sessionId).
   * Acquires the turn lock, runs the stream, and releases on finish or error.
   */
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
        yield { type: "error", error: mapStreamError(err, params.sessionId) };
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

  private async sendViaWebhook(
    params: RequestParams,
    runId: string,
    turnId: string,
  ): Promise<WebhookSendResult> {
    const client = await this.getClient();
    const observer = this.edgeObserver!;

    this.log.info("send.start", {
      stage: "send.start",
      provider: ANTHROPIC,
      mode: "webhook",
      sessionId: params.sessionId,
      runId,
      turnId,
      messageCount: params.messages.length,
    });

    const sessionId =
      params.sessionId ??
      (await this.createSession({
        vaultIds: params.vaultIds,
        providerOptions: params.providerOptions,
      }));

    if (params.agent) {
      await this.applyAgentOverrides(client, sessionId, params.agent);
    }

    const request: SerializedRequestParams = {
      messages: params.messages,
      sessionId: params.sessionId,
      toolResults: params.toolResults,
      vaultIds: params.vaultIds,
      providerOptions: params.providerOptions,
      webhookMetadata: params.webhookMetadata,
      agent: sanitizeAgentForSerialization(params.agent),
    };

    const enqueueParams: EdgeEnqueueParams = {
      sessionId,
      runId,
      turnId,
      provider: ANTHROPIC,
      request,
      webhook: {
        ...observer.webhook,
        metadata: params.webhookMetadata,
      },
    };

    this.log.info("edge.enqueue", {
      stage: "edge.enqueue",
      provider: ANTHROPIC,
      sessionId,
      runId,
      turnId,
    });

    const enqueueStartedAt = Date.now();
    let status: "active" | "queued";
    try {
      ({ status } = await observer.enqueue(enqueueParams));
    } catch (err) {
      this.log.error("edge.enqueue.failed", {
        stage: "edge.enqueue.failed",
        provider: ANTHROPIC,
        sessionId,
        runId,
        error: logErrorMessage(err),
      });
      throw err;
    }

    if (status === "active") {
      await this.dispatchAndObserve(
        client,
        observer,
        sessionId,
        runId,
        turnId,
        params,
      );
    }

    this.log.info("send.complete", {
      stage: "send.complete",
      provider: ANTHROPIC,
      mode: "webhook",
      sessionId,
      runId,
      turnId,
      status,
      durationMs: Date.now() - enqueueStartedAt,
    });

    return { sessionId, runId, turnId, status };
  }

  private async dispatchAndObserve(
    client: Anthropic,
    observer: CloudflareEdgeObserver,
    sessionId: string,
    runId: string,
    turnId: string,
    params: RequestParams,
  ): Promise<void> {
    await this.dispatch(client, sessionId, params);

    const baseUrl = client.baseURL.replace(/\/+$/, "");
    const observeParams: EdgeObserveParams = {
      sessionId,
      runId,
      turnId,
      streamUrl: `${baseUrl}/v1/sessions/${sessionId}/events/stream`,
      headers: this.buildApiHeaders(client),
      provider: ANTHROPIC,
      webhook: {
        ...observer.webhook,
        metadata: params.webhookMetadata,
      },
    };

    await observer.observe(observeParams);
  }

  async dispatchQueued(
    sessionId: string,
    runId: string,
    turnId: string,
    request: SerializedRequestParams,
  ): Promise<void> {
    const client = await this.getClient();
    const observer = this.edgeObserver!;

    if (request.agent) {
      await this.applyAgentOverrides(client, sessionId, request.agent);
    }

    const params: RequestParams = {
      messages: request.messages,
      sessionId: request.sessionId,
      toolResults: request.toolResults,
      vaultIds: request.vaultIds,
      providerOptions: request.providerOptions,
      webhookMetadata: request.webhookMetadata,
      agent: request.agent,
    };

    await this.dispatchAndObserve(
      client,
      observer,
      sessionId,
      runId,
      turnId,
      params,
    );
  }

  private async dispatch(
    client: Anthropic,
    sessionId: string,
    params: RequestParams,
    signal?: AbortSignal,
  ): Promise<void> {
    const events = params.toolResults?.length
      ? params.toolResults.map(toSessionEvent)
      : buildSendEvents(params);
    const sendParams: EventSendParams = { events };

    this.log.debug("dispatch.events", {
      stage: "dispatch.events",
      provider: ANTHROPIC,
      sessionId,
      eventCount: events.length,
      eventTypes: events.map((event) => event.type),
    });

    await client.beta.sessions.events.send(sessionId, sendParams, { signal });
  }

  private async getStatus(
    client: Anthropic,
    sessionId: string,
  ): Promise<string> {
    const session = await client.beta.sessions.retrieve(sessionId);
    return session.status;
  }

  /**
   * Iterates raw provider events, deduplicates by ID, maps to StreamParts.
   * Shared by both live SSE and historical catch-up paths.
   * Optional onEvent callback fires after each new event (used for checkpointing).
   */
  private async *consumeEvents(
    source: AsyncIterable<{ id: string }>,
    seenIds: Set<string>,
    acc: ResponseAccumulator,
    onEvent?: (eventId: string) => Promise<void>,
  ): AsyncGenerator<StreamPart> {
    for await (const raw of source) {
      if (seenIds.has(raw.id)) continue;
      seenIds.add(raw.id);
      yield* mapEvent(raw as BetaManagedAgentsStreamSessionEvents, acc);
      if (onEvent) await onEvent(raw.id);
      if (acc.done) return;
    }
  }

  /**
   * Wraps SSE observation with auto-reconnect on transient network failures.
   * Accumulator and seenIds live for the duration of one send() call to
   * survive TCP resets / proxy timeouts without losing events.
   *
   * @param onConnected Called once after the first SSE connection opens.
   *   Callers pass dispatch() here so events are sent only after SSE is live,
   *   avoiding the race where dispatch fires before the stream is open.
   */
  private async *resilientObserve(
    client: Anthropic,
    sessionId: string,
    runId: string,
    signal?: AbortSignal,
    onConnected?: () => Promise<void>,
    initialSeenIds?: Set<string>,
  ): AsyncIterable<StreamPart> {
    const seenIds = initialSeenIds ?? new Set<string>();
    const acc = new ResponseAccumulator();
    const backend = this.checkpointBackend;
    const onEvent = backend
      ? (eventId: string) =>
          backend.save({
            sessionId,
            provider: "anthropic",
            lastEventId: eventId,
            createdAt: Date.now(),
            runId,
          })
      : undefined;
    let retries = 0;
    let connected = false;

    while (retries <= MAX_RECONNECT_RETRIES) {
      try {
        const sseStream = await client.beta.sessions.events.stream(
          sessionId,
          undefined,
          { signal },
        );

        if (!connected) {
          if (onConnected) await onConnected();
          connected = true;
        } else {
          try {
            const missed = await client.beta.sessions.events.list(sessionId);
            yield* this.consumeEvents(missed, seenIds, acc, onEvent);
            if (acc.done) {
              if (backend) await backend.remove(sessionId);
              yield { type: "finish", response: acc.toResponse(sessionId) };
              return;
            }
          } catch {
            // List failed — still worth tailing SSE
          }
        }

        yield* this.consumeEvents(sseStream, seenIds, acc, onEvent);
        if (backend) await backend.remove(sessionId);
        yield { type: "finish", response: acc.toResponse(sessionId) };
        return;
      } catch (err) {
        if (!isTransientStreamError(err, signal)) throw err;

        retries++;
        if (retries > MAX_RECONNECT_RETRIES) throw err;

        this.log.warn("stream.reconnect", {
          stage: "stream.reconnect",
          provider: ANTHROPIC,
          sessionId,
          runId,
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
    const client = await this.getClient();

    await Promise.allSettled(
      active.map(async (checkpoint) => {
        try {
          const status = await this.getStatus(client, checkpoint.sessionId);

          if (status === "running" || status === "idle") {
            const { runId } = checkpoint;
            const recoveryTurnId = crypto.randomUUID();
            const callbacks = onSessionEvents({
              sessionId: checkpoint.sessionId,
              turnId: recoveryTurnId,
              runId,
              metadata: {},
            });
            const stream = this.recoverStream(
              client,
              checkpoint,
              runId,
              status === "running",
            );
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
                provider: ANTHROPIC,
                sessionId: checkpoint.sessionId,
                runId,
                error: logErrorMessage(err),
              });
              await backend.remove(checkpoint.sessionId).catch(() => {});
            });
          } else {
            await backend.remove(checkpoint.sessionId);
          }
        } catch {
          await backend.remove(checkpoint.sessionId).catch(() => {});
        }
      }),
    );
  }

  /**
   * Generates a stream for a recovered session: fetches all historical events,
   * skips ones already delivered (up to checkpoint.lastEventId), then resumes
   * live SSE if the session is still running.
   */
  private async *recoverStream(
    client: Anthropic,
    checkpoint: SessionCheckpoint,
    runId: string,
    stillRunning: boolean,
  ): AsyncIterable<StreamPart> {
    const { sessionId, lastEventId } = checkpoint;
    const backend = this.checkpointBackend;
    const seenIds = new Set<string>();
    const acc = new ResponseAccumulator();
    const onEvent = backend
      ? (eventId: string) =>
          backend.save({
            sessionId,
            provider: "anthropic",
            lastEventId: eventId,
            createdAt: Date.now(),
            runId,
          })
      : undefined;

    yield { type: "stream-start", sessionId };

    const sseStream = stillRunning
      ? await client.beta.sessions.events.stream(sessionId)
      : undefined;

    const allEvents = await client.beta.sessions.events.list(sessionId);
    let pastCheckpoint = false;

    for await (const raw of allEvents) {
      seenIds.add(raw.id);
      if (!pastCheckpoint) {
        if (raw.id === lastEventId) pastCheckpoint = true;
        continue;
      }
      yield* mapEvent(raw as BetaManagedAgentsStreamSessionEvents, acc);
      if (onEvent) await onEvent(raw.id);
      if (acc.done) break;
    }

    if (sseStream && !acc.done) {
      yield* this.consumeEvents(sseStream, seenIds, acc, onEvent);
    }

    if (backend) await backend.remove(sessionId);
    yield { type: "finish", response: acc.toResponse(sessionId) };
  }

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

  private buildApiHeaders(client: Anthropic): Record<string, string> {
    return {
      "x-api-key": client.apiKey ?? "",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "managed-agents-2026-04-01",
      ...("awsRegion" in this.config && this.config.awsWorkspaceId
        ? { "anthropic-workspace-id": this.config.awsWorkspaceId }
        : {}),
    };
  }

  private async *runStream(
    params: RequestParams,
    runId: string,
  ): AsyncIterable<StreamPart> {
    try {
      const client = await this.getClient();
      const sessionId =
        params.sessionId ??
        (await this.createSession({
          vaultIds: params.vaultIds,
          providerOptions: params.providerOptions,
        }));

      yield { type: "stream-start", sessionId };

      if (params.agent) {
        await this.applyAgentOverrides(client, sessionId, params.agent);
      }

      const signal = params.abortSignal ?? undefined;
      yield* this.resilientObserve(client, sessionId, runId, signal, () =>
        this.dispatch(client, sessionId, params, signal),
      );
    } catch (err) {
      const error = mapStreamError(err, params.sessionId);
      yield { type: "error", error };
    }
  }

  private async applyAgentOverrides(
    client: Anthropic,
    sessionId: string,
    agentConfig: AgentSessionConfig,
  ): Promise<void> {
    const session = await client.beta.sessions.retrieve(sessionId);
    const agentUpdate = buildSessionAgentUpdate(agentConfig, session);
    if (!agentUpdate) return;

    await client.beta.sessions.update(sessionId, { agent: agentUpdate });
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

    this.log.info("session.create", {
      stage: "session.create",
      provider: ANTHROPIC,
      sessionId: session.id,
      vaultIdCount: options?.vaultIds?.length ?? 0,
    });

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

export function createAnthropicProvider(
  config: AnthropicProviderConfig & { durable: EdgeObserver },
): WebhookProvider;
export function createAnthropicProvider(
  config: AnthropicProviderConfig,
): StreamingProvider;
export function createAnthropicProvider(
  config: AnthropicProviderConfig,
): StreamingProvider | WebhookProvider {
  return new AnthropicProvider(config) as StreamingProvider | WebhookProvider;
}
