import Anthropic, { APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import type {
  BetaManagedAgentsEventParams,
  BetaManagedAgentsStreamSessionEvents,
  BetaManagedAgentsUserCustomToolResultEventParams,
  BetaManagedAgentsUserMessageEventParams,
  BetaManagedAgentsUserToolConfirmationEventParams,
  EventSendParams,
} from "@anthropic-ai/sdk/resources/beta/sessions";
import type { SessionCreateParams } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import type { CloudflareEdgeObserver } from "../durable/cloudflare";
import {
  type DurabilityBackend,
  type DurableBackend,
  type EdgeObserver,
  isEdgeObserver,
  type SessionCheckpoint,
} from "../durable/types";
import { AbortedError, SessionExpiredError, ThalamusError } from "../errors";
import { createSendResult } from "../send-result";
import {
  ANTHROPIC,
  type Provider,
  type RequestParams,
  type Response,
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
import { toContentBlocks } from "./anthropic.transformer";
import { AnthropicVault } from "./anthropic.vault";
import { mapEvent, ResponseAccumulator } from "./anthropic-parser";
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

  constructor(config: AnthropicProviderConfig) {
    this.config = config;
    this.agentId = config.agentId;
    this.environmentId = config.environmentId;
    this.runtimeId = config.agentId;

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
    if (this.edgeObserver) {
      return this.sendViaWebhook(params, runId);
    }
    const callbacks = this.config.onSessionEvents
      ? this.config.onSessionEvents(params.sessionId ?? "<<pending>>", runId)
      : undefined;
    return createSendResult(this.runStream(params, runId), runId, callbacks, {
      autoStart: !!this.config.onSessionEvents,
    });
  }

  private async sendViaWebhook(
    params: RequestParams,
    runId: string,
  ): Promise<WebhookSendResult> {
    const client = await this.getClient();
    const sessionId =
      params.sessionId ??
      (await this.createSession({
        vaultIds: params.vaultIds,
        providerOptions: params.providerOptions,
      }));
    await this.edgeObserve(client, sessionId, runId, params);
    return { sessionId, runId };
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
            const callbacks = onSessionEvents(checkpoint.sessionId, runId);
            const stream = this.recoverStream(
              client,
              checkpoint,
              runId,
              status === "running",
            );
            const result = createSendResult(stream, runId, callbacks, {
              autoStart: true,
            });
            result.response.catch(async (err) => {
              console.error(
                `[thalamus] recovery stream failed for ${checkpoint.sessionId}:`,
                err instanceof Error ? err.message : err,
              );
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

  private async edgeObserve(
    client: Anthropic,
    sessionId: string,
    runId: string,
    params: RequestParams,
  ): Promise<void> {
    const observer = this.edgeObserver!;

    await observer.observe({
      sessionId,
      runId,
      streamUrl: `${client.baseURL}/v1/sessions/${sessionId}/events/stream`,
      headers: {
        "x-api-key": client.apiKey ?? "",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "managed-agents-2026-04-01",
        ...("awsRegion" in this.config && this.config.awsWorkspaceId
          ? { "anthropic-workspace-id": this.config.awsWorkspaceId }
          : {}),
      },
      provider: "anthropic",
      webhook: {
        ...observer.webhook,
        metadata: params.webhookMetadata,
      },
    });

    await this.dispatch(client, sessionId, params);
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

      const signal = params.abortSignal ?? undefined;
      yield* this.resilientObserve(client, sessionId, runId, signal, () =>
        this.dispatch(client, sessionId, params, signal),
      );
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
