import type { protos } from "@google-cloud/discoveryengine";
import type { CloudflareEdgeObserver } from "../durable/cloudflare";
import { sanitizeAgentForSerialization } from "../durable/serialize-agent";
import {
  type DurableBackend,
  type EdgeObserver,
  isEdgeObserver,
  type SerializedRequestParams,
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
  GOOGLE,
  type Message,
  MessageRole,
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
import type { Vault, VaultOptions, VaultStore } from "../vault/vault.interface";
import { deliverWebhookEvent } from "../webhook/deliver";
import {
  createProviderWebhookHandler,
  type WebhookHandler,
} from "../webhook/index";
import {
  mapChunk,
  ResponseAccumulator,
  type StreamAssistResponse,
} from "./google-parser";

type StreamAssistRequest =
  protos.google.cloud.discoveryengine.v1beta.IStreamAssistRequest;

type CancellableAssistStream = AsyncIterable<StreamAssistResponse> & {
  cancel?: () => void;
};

export type GoogleStreamAssist = (
  request: StreamAssistRequest,
) => AsyncIterable<StreamAssistResponse> | CancellableAssistStream;

type AssistantClient = {
  streamAssist: (request: StreamAssistRequest) => CancellableAssistStream;
};

export interface GoogleProviderConfig {
  projectId: string;
  /** GCP location. Defaults to `"global"`. */
  location?: string;
  engineId: string;
  /** Gemini Enterprise assistant ID. Defaults to `"default_assistant"`. */
  assistantId?: string;
  /**
   * Billing/quota project for `x-goog-user-project`.
   * Defaults to `projectId`.
   */
  quotaProjectId?: string;
  /** Test seam. Production uses `AssistantServiceClient` + ADC. */
  streamAssist?: GoogleStreamAssist;
  /** Test seam. Production uses `SessionServiceClient.createSession`. */
  createSession?: () => Promise<string>;
  durable?: DurableBackend;
  vaultStore?: VaultStore;
  onSessionEvents?: SessionEventsFactory;
  logger?: ThalamusLoggerInput;
}

export function assistantResourceName(config: GoogleProviderConfig): string {
  const location = config.location ?? "global";
  const assistantId = config.assistantId ?? "default_assistant";
  return (
    `projects/${config.projectId}/locations/${location}` +
    `/collections/default_collection/engines/${config.engineId}` +
    `/assistants/${assistantId}`
  );
}

export function discoveryEngineEndpoint(location = "global"): string {
  return location === "global"
    ? "global-discoveryengine.googleapis.com"
    : `${location}-discoveryengine.googleapis.com`;
}

export function engineResourceName(config: GoogleProviderConfig): string {
  const location = config.location ?? "global";
  return (
    `projects/${config.projectId}/locations/${location}` +
    `/collections/default_collection/engines/${config.engineId}`
  );
}

/** GE `streamAssist` takes one `query.text`. History lives in the GE session. */
function toQuery(messages: Message[]): { text: string } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== MessageRole.USER) continue;
    if (typeof msg.content === "string") return { text: msg.content };
    const text = msg.content
      .filter(
        (part): part is { type: "text"; text: string } => part.type === "text",
      )
      .map((part) => part.text)
      .join("");
    return { text };
  }
  return { text: "" };
}

function streamAssistRequest(
  name: string,
  messages: Message[],
  sessionId: string | undefined,
  providerOptions?: Record<string, unknown>,
): StreamAssistRequest {
  const extras = { ...(providerOptions ?? {}) } as StreamAssistRequest;
  delete extras.name;
  delete extras.query;
  delete extras.session;
  return {
    ...extras,
    name,
    query: toQuery(messages),
    ...(sessionId ? { session: sessionId } : {}),
  };
}

function grpcCode(err: unknown): number | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "number") return code;
  }
  return undefined;
}

export function mapGoogleError(err: unknown): Error {
  if (err instanceof ThalamusError) return err;
  if (err instanceof Error && err.name === "AbortError") {
    return new AbortedError({ provider: GOOGLE, cause: err });
  }

  const code = grpcCode(err);
  const msg = err instanceof Error ? err.message : String(err);

  if (code === 1) {
    return new AbortedError({ provider: GOOGLE, cause: err });
  }
  if (code === 16 || code === 7) {
    return new ProviderAuthError(msg, { provider: GOOGLE, cause: err });
  }
  if (code === 8) {
    return new ProviderRateLimitError(msg, { provider: GOOGLE, cause: err });
  }
  if (code === 14 || code === 4 || code === 13) {
    return new ProviderUnavailableError(msg, { provider: GOOGLE, cause: err });
  }
  return new ProviderResponseError(msg, { provider: GOOGLE, cause: err });
}

async function loadV1beta() {
  const { v1beta } = await import("@google-cloud/discoveryengine");
  return v1beta;
}

async function createClient(
  config: GoogleProviderConfig,
): Promise<AssistantClient> {
  const location = config.location ?? "global";
  const v1beta = await loadV1beta();
  return new v1beta.AssistantServiceClient({
    apiEndpoint: discoveryEngineEndpoint(location),
    projectId: config.projectId,
    quotaProjectId: config.quotaProjectId ?? config.projectId,
  });
}

async function* watchAbort(
  stream: CancellableAssistStream,
  signal: AbortSignal | undefined,
  sessionId: string | undefined,
): AsyncIterable<StreamAssistResponse> {
  if (signal?.aborted) {
    stream.cancel?.();
    throw new AbortedError({ provider: GOOGLE, sessionId });
  }

  const cancel = () => stream.cancel?.();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) {
        throw new AbortedError({ provider: GOOGLE, sessionId });
      }
      yield chunk;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

class GoogleProvider {
  readonly provider = GOOGLE;
  readonly runtimeId: string;

  private readonly config: GoogleProviderConfig;
  private readonly log: ThalamusLogger;
  private readonly turnLock = new SessionMutex();
  private readonly assistantName: string;
  private client: AssistantClient | undefined;

  constructor(config: GoogleProviderConfig) {
    this.config = config;
    this.runtimeId = `${config.projectId}/${config.engineId}`;
    this.log = resolveLogger(config.logger);
    this.assistantName = assistantResourceName(config);
  }

  private get edgeObserver(): CloudflareEdgeObserver | null {
    return this.config.durable && isEdgeObserver(this.config.durable)
      ? (this.config.durable as CloudflareEdgeObserver)
      : null;
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

    const stream = this.streamWithLock(params, runId);
    return createSendResult(stream, runId, turnId, callbacks, {
      autoStart: !!this.config.onSessionEvents,
    });
  }

  private async sendViaWebhook(
    params: RequestParams,
    runId: string,
    turnId: string,
  ): Promise<WebhookSendResult> {
    const observer = this.edgeObserver!;
    const sessionId = params.sessionId ?? (await this.createSession());

    this.log.info("send.start", {
      stage: "send.start",
      provider: GOOGLE,
      mode: "webhook",
      sessionId,
      runId,
      turnId,
    });

    const serializedRequest: SerializedRequestParams = {
      messages: params.messages,
      sessionId,
      toolResults: params.toolResults,
      vaultIds: params.vaultIds,
      providerOptions: params.providerOptions,
      webhookMetadata: params.webhookMetadata,
      agent: sanitizeAgentForSerialization(params.agent),
    };

    this.log.info("edge.enqueue", {
      stage: "edge.enqueue",
      provider: GOOGLE,
      sessionId,
      runId,
      turnId,
    });

    const enqueueStartedAt = Date.now();
    let enqueueResult: { status: "active" | "queued" };
    try {
      enqueueResult = await observer.enqueue({
        sessionId,
        runId,
        turnId,
        provider: GOOGLE,
        request: serializedRequest,
        webhook: {
          ...observer.webhook,
          metadata: params.webhookMetadata,
        },
      });
    } catch (err) {
      this.log.error("edge.enqueue.failed", {
        stage: "edge.enqueue.failed",
        provider: GOOGLE,
        sessionId,
        runId,
        error: logErrorMessage(err),
      });
      throw err;
    }

    if (enqueueResult.status === "active") {
      await this.dispatchAndObserve(sessionId, runId, turnId, {
        ...params,
        sessionId,
      });
    }

    this.log.info("send.complete", {
      stage: "send.complete",
      provider: GOOGLE,
      mode: "webhook",
      sessionId,
      runId,
      turnId,
      durationMs: Date.now() - enqueueStartedAt,
    });

    return {
      sessionId,
      runId,
      turnId,
      status: enqueueResult.status,
    };
  }

  /**
   * streamAssist is gRPC — the Cloudflare observer cannot attach to an SSE URL.
   * Consume the stream in-process and POST StreamParts to the webhook.
   */
  private async dispatchAndObserve(
    sessionId: string,
    runId: string,
    turnId: string,
    params: RequestParams,
  ): Promise<void> {
    const observer = this.edgeObserver!;
    let sequence = 1;

    try {
      for await (const event of this.runStream(params, runId)) {
        await deliverWebhookEvent({
          url: observer.webhook.url,
          secret: observer.webhook.secret,
          sessionId,
          runId,
          turnId,
          sequence,
          provider: GOOGLE,
          metadata: params.webhookMetadata,
          event,
        });
        sequence += 1;
      }
    } finally {
      await observer.stop(sessionId).catch(() => {});
    }
  }

  async dispatchQueued(
    sessionId: string,
    runId: string,
    turnId: string,
    request: SerializedRequestParams,
  ): Promise<void> {
    await this.dispatchAndObserve(sessionId, runId, turnId, {
      messages: request.messages,
      sessionId,
      toolResults: request.toolResults,
      vaultIds: request.vaultIds,
      providerOptions: request.providerOptions,
      webhookMetadata: request.webhookMetadata,
      agent: request.agent,
    });
  }

  private async *streamWithLock(
    params: RequestParams,
    runId: string,
  ): AsyncIterable<StreamPart> {
    let release: (() => void) | undefined;
    try {
      if (params.sessionId) {
        yield { type: "status-change", status: "queued" };
      }

      const lockKey = params.sessionId ?? runId;
      release = await this.turnLock.acquire(lockKey, params.abortSignal);
      yield* this.withTurnRelease(this.runStream(params, runId), release);
    } catch (err) {
      release?.();
      throw err;
    }
  }

  private async *withTurnRelease(
    stream: AsyncIterable<StreamPart>,
    release: (() => void) | undefined,
  ): AsyncIterable<StreamPart> {
    try {
      for await (const part of stream) {
        yield part;
      }
    } finally {
      release?.();
    }
  }

  private async openStream(
    request: StreamAssistRequest,
  ): Promise<CancellableAssistStream> {
    if (this.config.streamAssist) return this.config.streamAssist(request);
    if (!this.client) this.client = await createClient(this.config);
    return this.client.streamAssist(request);
  }

  private async *runStream(
    params: RequestParams,
    runId: string,
  ): AsyncIterable<StreamPart> {
    const sessionId = params.sessionId;
    let runStarted = false;

    if (sessionId) {
      runStarted = true;
      yield { type: "run-start", sessionId };
    }

    this.log.info("send.start", {
      stage: "send.start",
      provider: GOOGLE,
      mode: "stream",
      sessionId,
      runId,
      newSession: !sessionId,
    });

    try {
      if (params.abortSignal?.aborted) {
        throw new AbortedError({ provider: GOOGLE, sessionId });
      }

      const request = streamAssistRequest(
        this.assistantName,
        params.messages,
        sessionId,
        params.providerOptions,
      );

      yield { type: "status-change", status: "running" };

      const acc = new ResponseAccumulator();
      const stream = await this.openStream(request);
      for await (const chunk of watchAbort(
        stream,
        params.abortSignal,
        sessionId,
      )) {
        if (!runStarted && chunk.sessionInfo?.session) {
          acc.sessionId = chunk.sessionInfo.session;
          runStarted = true;
          yield { type: "run-start", sessionId: acc.sessionId };
        }
        yield* mapChunk(chunk, acc);
        if (acc.done) break;
      }

      if (!acc.done) {
        acc.finishReason = "error";
      }

      if (!runStarted && acc.sessionId) {
        runStarted = true;
        yield { type: "run-start", sessionId: acc.sessionId };
      }

      const resolvedSession = acc.sessionId ?? sessionId;
      const finalResponse = { ...acc.toResponse(), sessionId: resolvedSession };

      this.log.info("send.complete", {
        stage: "send.complete",
        provider: GOOGLE,
        mode: "stream",
        sessionId: resolvedSession,
        runId,
      });

      yield { type: "finish", response: finalResponse };
    } catch (err) {
      const error = mapGoogleError(err);
      this.log.error("stream.error", {
        stage: "stream.error",
        provider: GOOGLE,
        mode: "stream",
        sessionId,
        runId,
        error: logErrorMessage(error),
      });
      yield { type: "error", error };
    }
  }

  async createSession(_options?: SessionOptions): Promise<string> {
    if (this.config.createSession) {
      return this.config.createSession();
    }

    if (!this.edgeObserver) {
      throw new ThalamusError(
        "Gemini Enterprise creates sessions on the first send(). Use response.sessionId from that turn.",
        { provider: GOOGLE, isRetryable: false },
      );
    }

    const location = this.config.location ?? "global";
    const v1beta = await loadV1beta();
    const client = new v1beta.SessionServiceClient({
      apiEndpoint: discoveryEngineEndpoint(location),
      projectId: this.config.projectId,
      quotaProjectId: this.config.quotaProjectId ?? this.config.projectId,
    });
    const [session] = await client.createSession({
      parent: engineResourceName(this.config),
      session: {},
    });

    if (!session.name) {
      throw new ThalamusError(
        "Discovery Engine createSession returned no name",
        {
          provider: GOOGLE,
          isRetryable: false,
        },
      );
    }

    this.log.info("session.create", {
      stage: "session.create",
      provider: GOOGLE,
      sessionId: session.name,
    });

    return session.name;
  }

  async endSession(_sessionId: string): Promise<void> {}

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

  async createVault(options: VaultOptions): Promise<Vault> {
    if (!this.config.vaultStore) {
      throw new ThalamusError(
        "Pass a vaultStore to createGoogleProvider() to use vault operations",
        { provider: GOOGLE, isRetryable: false },
      );
    }
    const record = await this.config.vaultStore.createVault(options);
    return new LocalVault(record.id, GOOGLE, this.config.vaultStore);
  }

  async getVault(vaultId: string): Promise<Vault> {
    if (!this.config.vaultStore) {
      throw new ThalamusError(
        "vaultStore is required for Google vault support",
        {
          provider: GOOGLE,
          isRetryable: false,
        },
      );
    }
    const record = await this.config.vaultStore.getVault(vaultId);
    if (!record) {
      throw new ThalamusError(`Vault not found: ${vaultId}`, {
        provider: GOOGLE,
        isRetryable: false,
      });
    }
    return new LocalVault(record.id, GOOGLE, this.config.vaultStore);
  }
}

export function createGoogleProvider(
  config: GoogleProviderConfig & { durable: EdgeObserver },
): WebhookProvider;
export function createGoogleProvider(
  config: GoogleProviderConfig,
): StreamingProvider;
export function createGoogleProvider(
  config: GoogleProviderConfig,
): StreamingProvider | WebhookProvider {
  return new GoogleProvider(config) as StreamingProvider | WebhookProvider;
}
