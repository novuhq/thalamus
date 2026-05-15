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
import type {
  DurabilityBackend,
  EdgeObserver,
  SessionCheckpoint,
} from "../durable/types";
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
  durable?: DurabilityBackend;
  edgeObserver?: EdgeObserver;
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

const MAX_RECONNECT_RETRIES = 3;

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

    if (config.durable && config.onSessionEvents) {
      this.recoverActiveSessions().catch(() => {});
    }
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
    signal?: AbortSignal,
    onConnected?: () => Promise<void>,
    initialSeenIds?: Set<string>,
  ): AsyncIterable<StreamPart> {
    const seenIds = initialSeenIds ?? new Set<string>();
    const acc = new ResponseAccumulator();
    const durable = this.config.durable;
    const onEvent = durable
      ? (eventId: string) =>
          durable.save({
            sessionId,
            provider: "anthropic",
            lastEventId: eventId,
            createdAt: Date.now(),
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
          // First connection — dispatch, then tail
          if (onConnected) await onConnected();
          connected = true;
        } else {
          // Reconnect: SSE is open and buffering; catch up via history first
          try {
            const missed = await client.beta.sessions.events.list(sessionId);
            yield* this.consumeEvents(missed, seenIds, acc, onEvent);
            if (acc.done) {
              if (durable) await durable.remove(sessionId);
              yield { type: "finish", response: acc.toResponse(sessionId) };
              return;
            }
          } catch {
            // List failed — still worth tailing SSE
          }
        }

        yield* this.consumeEvents(sseStream, seenIds, acc, onEvent);
        if (durable) await durable.remove(sessionId);
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
   * Best-effort recovery of sessions that were active before a process restart.
   * Fires onSessionEvents callbacks for missed events, then resumes live
   * observation for sessions that are still running.
   */
  private async recoverActiveSessions(): Promise<void> {
    const { durable, onSessionEvents } = this.config;
    if (!durable || !onSessionEvents) return;

    const active = await durable.getActive();
    const client = await this.getClient();

    await Promise.allSettled(
      active.map(async (checkpoint) => {
        try {
          const status = await this.getStatus(client, checkpoint.sessionId);

          if (status === "running" || status === "idle") {
            const callbacks = onSessionEvents(checkpoint.sessionId);
            const stream = this.recoverStream(
              client,
              checkpoint,
              status === "running",
            );
            const result = createSendResult(stream, callbacks, {
              autoStart: true,
            });
            result.response.catch(async (err) => {
              console.error(
                `[thalamus] recovery stream failed for ${checkpoint.sessionId}:`,
                err instanceof Error ? err.message : err,
              );
              await durable.remove(checkpoint.sessionId).catch(() => {});
            });
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
   * Generates a stream for a recovered session: fetches all historical events,
   * skips ones already delivered (up to checkpoint.lastEventId), then resumes
   * live SSE if the session is still running.
   */
  private async *recoverStream(
    client: Anthropic,
    checkpoint: SessionCheckpoint,
    stillRunning: boolean,
  ): AsyncIterable<StreamPart> {
    const { sessionId, lastEventId } = checkpoint;
    const durable = this.config.durable;
    const seenIds = new Set<string>();
    const acc = new ResponseAccumulator();
    const onEvent = durable
      ? (eventId: string) =>
          durable.save({
            sessionId,
            provider: "anthropic",
            lastEventId: eventId,
            createdAt: Date.now(),
          })
      : undefined;

    yield { type: "stream-start", sessionId };

    // For running sessions, open SSE first so it buffers while we list history
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

    if (durable) await durable.remove(sessionId);
    yield { type: "finish", response: acc.toResponse(sessionId) };
  }

  /**
   * Edge observation: SSE runs on the CF Agent, events arrive via WebSocket.
   * The provider dispatches the message directly and reads parsed events
   * from the edge observer's WebSocket feed.
   */
  private async *edgeObserve(
    client: Anthropic,
    sessionId: string,
    params: RequestParams,
    signal?: AbortSignal,
  ): AsyncIterable<StreamPart> {
    const observer = this.config.edgeObserver as NonNullable<
      typeof this.config.edgeObserver
    >;

    const eventStream = observer.events(sessionId);

    await observer.observe({
      sessionId,
      streamUrl: `${client.baseURL}/v1/sessions/${sessionId}/events/stream`,
      headers: {
        "x-api-key": client.apiKey ?? "",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "managed-agents-2026-04-01",
      },
    });

    await this.dispatch(client, sessionId, params, signal);

    const acc = new ResponseAccumulator();
    for await (const frame of eventStream) {
      if (signal?.aborted) break;
      if (!frame.data) continue;
      const rawEvent = JSON.parse(frame.data);
      yield* mapEvent(rawEvent as BetaManagedAgentsStreamSessionEvents, acc);
      if (acc.done) break;
    }

    yield { type: "finish", response: acc.toResponse(sessionId) };
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

      if (this.config.edgeObserver) {
        yield* this.edgeObserve(client, sessionId, params, signal);
      } else {
        yield* this.resilientObserve(client, sessionId, signal, () =>
          this.dispatch(client, sessionId, params, signal),
        );
      }
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
