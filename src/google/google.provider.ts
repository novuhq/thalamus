import { type protos, v1beta } from "@google-cloud/discoveryengine";
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
  type RequestParams,
  type SendResult,
  type SessionEventsFactory,
  type SessionOptions,
  type StreamingProvider,
  type StreamPart,
} from "../types";
import { LocalVault } from "../vault/local-vault";
import type { Vault, VaultOptions, VaultStore } from "../vault/vault.interface";
import {
  mapChunk,
  ResponseAccumulator,
  type StreamAssistResponse,
} from "./google-parser";

type StreamAssistRequest =
  protos.google.cloud.discoveryengine.v1beta.IStreamAssistRequest;

export type GoogleStreamAssist = (
  request: StreamAssistRequest,
) => AsyncIterable<StreamAssistResponse>;

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

/** GE `streamAssist` takes one `query.text`. History lives in the GE session. */
function toQuery(messages: Message[]): { text: string } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== MessageRole.USER) continue;
    if (typeof msg.content === "string") return { text: msg.content };
    for (const part of msg.content) {
      if (part.type === "text") return { text: part.text };
    }
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

function createClient(
  config: GoogleProviderConfig,
): v1beta.AssistantServiceClient {
  const location = config.location ?? "global";
  return new v1beta.AssistantServiceClient({
    apiEndpoint: discoveryEngineEndpoint(location),
    projectId: config.projectId,
    quotaProjectId: config.quotaProjectId ?? config.projectId,
  });
}

class GoogleProvider {
  readonly provider = GOOGLE;
  readonly runtimeId: string;

  private readonly config: GoogleProviderConfig;
  private readonly log: ThalamusLogger;
  private readonly turnLock = new SessionMutex();
  private readonly assistantName: string;
  private client: v1beta.AssistantServiceClient | undefined;

  constructor(config: GoogleProviderConfig) {
    this.config = config;
    this.runtimeId = `${config.projectId}/${config.engineId}`;
    this.log = resolveLogger(config.logger);
    this.assistantName = assistantResourceName(config);
  }

  send(params: RequestParams): SendResult {
    const runId = crypto.randomUUID();
    const turnId = params.turnId ?? crypto.randomUUID();

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

  private async *streamWithLock(
    params: RequestParams,
    runId: string,
  ): AsyncIterable<StreamPart> {
    let release: (() => void) | undefined;
    try {
      if (params.sessionId) {
        yield { type: "status-change", status: "queued" };
      }

      const lockKey = params.sessionId ?? this.runtimeId;
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

  private openStream(
    request: StreamAssistRequest,
  ): AsyncIterable<StreamAssistResponse> {
    if (this.config.streamAssist) return this.config.streamAssist(request);
    if (!this.client) this.client = createClient(this.config);
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
      for await (const chunk of this.openStream(request)) {
        if (params.abortSignal?.aborted) {
          throw new AbortedError({ provider: GOOGLE, sessionId });
        }
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
    throw new ThalamusError(
      "Gemini Enterprise creates sessions on the first send(). Use response.sessionId from that turn.",
      { provider: GOOGLE, isRetryable: false },
    );
  }

  async endSession(_sessionId: string): Promise<void> {}

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
  config: GoogleProviderConfig,
): StreamingProvider {
  return new GoogleProvider(config) as StreamingProvider;
}
