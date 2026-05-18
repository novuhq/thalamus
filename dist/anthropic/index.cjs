"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/anthropic/index.ts
var anthropic_exports = {};
__export(anthropic_exports, {
  createAnthropicProvider: () => createAnthropicProvider,
  toContentBlocks: () => toContentBlocks
});
module.exports = __toCommonJS(anthropic_exports);

// src/anthropic/anthropic.provider.ts
var import_sdk = __toESM(require("@anthropic-ai/sdk"), 1);

// src/durable/types.ts
function isEdgeObserver(backend) {
  return "observe" in backend && "events" in backend;
}

// src/errors.ts
var ThalamusError = class extends Error {
  provider;
  isRetryable;
  cause;
  constructor(message, options) {
    super(message, { cause: options.cause });
    this.name = "ThalamusError";
    this.provider = options.provider;
    this.isRetryable = options.isRetryable;
    this.cause = options.cause;
  }
};
var SessionExpiredError = class extends ThalamusError {
  sessionId;
  constructor(message, options) {
    super(message, { ...options, isRetryable: true });
    this.name = "SessionExpiredError";
    this.sessionId = options.sessionId;
  }
};
var AbortedError = class extends ThalamusError {
  sessionId;
  constructor(options) {
    super("Operation aborted", { ...options, isRetryable: false });
    this.name = "AbortedError";
    this.sessionId = options.sessionId;
  }
};

// src/send-result.ts
var CALLBACK_MAP = {
  "text-delta": "onTextDelta",
  thinking: "onThinking",
  refusal: "onRefusal",
  "tool-use-start": "onToolUseStart",
  "tool-use-delta": "onToolUseDelta",
  "tool-use-done": "onToolUseDone",
  "tool-use-result": "onToolUseResult",
  "mcp-tools-discovered": "onMcpToolsDiscovered",
  "status-change": "onStatusChange",
  "stream-start": "onStreamStart",
  finish: "onFinish",
  error: "onError",
  "provider-event": "onProviderEvent"
};
var SendResultImpl = class {
  constructor(source, callbacks, options) {
    this.source = source;
    this.callbacks = callbacks;
    this._sessionId = new Promise((resolve) => {
      this._sessionIdResolve = resolve;
    });
    if (options?.autoStart) {
      this._promise = this.run();
    }
  }
  source;
  callbacks;
  _promise = null;
  _sessionIdResolve;
  _sessionId;
  get sessionId() {
    this._promise ??= this.run();
    return this._sessionId;
  }
  get response() {
    this._promise ??= this.run();
    return this._promise;
  }
  // biome-ignore lint/suspicious/noThenProperty: intentional PromiseLike implementation
  then(onfulfilled, onrejected) {
    return this.response.then(onfulfilled, onrejected);
  }
  async text() {
    return (await this.response).content;
  }
  async run() {
    for await (const part of this.source) {
      if (part.type === "stream-start" && part.sessionId) {
        this._sessionIdResolve(part.sessionId);
      }
      this.dispatch(part);
      if (part.type === "finish") return part.response;
      if (part.type === "error") throw part.error;
    }
    throw new Error("Stream ended without a finish event");
  }
  dispatch(part) {
    if (!this.callbacks) return;
    this.callbacks.onPart?.(part);
    const key = CALLBACK_MAP[part.type];
    const cb = this.callbacks[key];
    if (cb) cb(part);
  }
};
function createSendResult(source, callbacks, options) {
  return new SendResultImpl(source, callbacks, options);
}

// src/types.ts
var ANTHROPIC = "anthropic";

// src/anthropic/anthropic.transformer.ts
function toContentBlocks(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  const blocks = [];
  for (const part of content) {
    switch (part.type) {
      case "text":
        blocks.push({ type: "text", text: part.text });
        break;
      case "image":
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: part.mediaType,
            data: part.data
          }
        });
        break;
      case "image-url":
        blocks.push({ type: "image", source: { type: "url", url: part.url } });
        break;
      case "file":
        blocks.push({
          type: "document",
          source: {
            type: "base64",
            media_type: part.mediaType,
            data: part.data
          },
          title: part.name ?? null
        });
        break;
    }
  }
  return blocks;
}

// src/anthropic/anthropic.vault.ts
var AnthropicVault = class {
  id;
  provider = ANTHROPIC;
  client;
  agentId;
  constructor(id, client, agentId) {
    this.id = id;
    this.client = client;
    this.agentId = agentId;
  }
  async resolveMcpServerUrl(name) {
    const agent = await this.client.beta.agents.retrieve(this.agentId);
    const server = (agent.mcp_servers ?? []).find((s) => s.name === name);
    if (!server) {
      const available = (agent.mcp_servers ?? []).map((s) => s.name).join(", ");
      throw new Error(
        `No MCP server named "${name}" on agent ${this.agentId}. Available: ${available}`
      );
    }
    return server.url;
  }
  toAuth(serverUrl, credential) {
    if (credential.type === "bearer") {
      const auth2 = {
        type: "static_bearer",
        mcp_server_url: serverUrl,
        token: credential.token
      };
      return auth2;
    }
    const auth = {
      type: "mcp_oauth",
      mcp_server_url: serverUrl,
      access_token: credential.accessToken,
      ...credential.expiresAt ? { expires_at: credential.expiresAt } : {},
      ...credential.refresh && {
        refresh: {
          refresh_token: credential.refresh.refreshToken,
          token_endpoint: credential.refresh.tokenEndpoint,
          client_id: credential.refresh.clientId,
          token_endpoint_auth: credential.refresh.clientSecret ? {
            type: "client_secret_basic",
            client_secret: credential.refresh.clientSecret
          } : { type: "none" },
          scope: credential.refresh.scopes
        }
      }
    };
    return auth;
  }
  async add(name, credential) {
    const url = await this.resolveMcpServerUrl(name);
    await this.client.beta.vaults.credentials.create(this.id, {
      display_name: name,
      auth: this.toAuth(url, credential)
    });
  }
  async update(name, credential) {
    await this.remove(name);
    await this.add(name, credential);
  }
  async remove(name) {
    const creds = [];
    for await (const c of this.client.beta.vaults.credentials.list(this.id)) {
      creds.push(c);
    }
    const match = creds.find((c) => c.display_name === name);
    if (!match) {
      throw new Error(`Credential "${name}" not found in vault ${this.id}`);
    }
    await this.client.beta.vaults.credentials.delete(match.id, {
      vault_id: this.id
    });
  }
  async list() {
    const result = [];
    for await (const c of this.client.beta.vaults.credentials.list(this.id)) {
      result.push({
        name: c.display_name ?? "",
        type: c.auth?.type === "static_bearer" ? "bearer" : "oauth",
        status: "active",
        createdAt: c.created_at,
        updatedAt: c.updated_at
      });
    }
    return result;
  }
  async destroy() {
    await this.client.beta.vaults.delete(this.id);
  }
};

// src/anthropic/anthropic.provider.ts
function mapStopReason(reason) {
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
function mapSessionError(raw) {
  const obj = raw;
  const msg = obj?.message ?? String(raw);
  const isAuth = obj?.type === "authentication_error";
  return new ThalamusError(msg, { provider: ANTHROPIC, isRetryable: !isAuth });
}
function mapStreamError(err, sessionId) {
  if (err instanceof import_sdk.APIUserAbortError) {
    return new AbortedError({ provider: ANTHROPIC, sessionId, cause: err });
  }
  if (sessionId && err instanceof import_sdk.APIError) {
    const status = err.status;
    if (status === 404 || status === 410) {
      return new SessionExpiredError(
        `Session ${sessionId} has expired or been archived`,
        { provider: ANTHROPIC, sessionId, cause: err }
      );
    }
  }
  if (err instanceof ThalamusError) return err;
  return new ThalamusError(String(err), {
    provider: ANTHROPIC,
    isRetryable: false,
    cause: err
  });
}
function isTransientStreamError(err, signal) {
  if (signal?.aborted) return false;
  if (err instanceof import_sdk.APIUserAbortError) return false;
  if (err instanceof ThalamusError) return false;
  return true;
}
function buildSendEvents(params) {
  if (params.toolResults?.length) {
    return params.toolResults.map(toSessionEvent);
  }
  const event = {
    type: "user.message",
    content: params.messages.flatMap((msg) => toContentBlocks(msg.content))
  };
  return [event];
}
function toSessionEvent(tr) {
  if (tr.approved !== void 0) {
    return {
      type: "user.tool_confirmation",
      tool_use_id: tr.toolUseId,
      result: tr.approved ? "allow" : "deny"
    };
  }
  return {
    type: "user.custom_tool_result",
    custom_tool_use_id: tr.toolUseId,
    content: [{ type: "text", text: tr.output ?? "" }]
  };
}
var ResponseAccumulator = class {
  content = "";
  finishReason = "stop";
  usage;
  actionsRequired = [];
  done = false;
  toResponse(sessionId) {
    return {
      content: this.content,
      sessionId,
      finishReason: this.finishReason,
      usage: this.usage,
      actionsRequired: this.actionsRequired.length > 0 ? this.actionsRequired : void 0
    };
  }
};
function* mapEvent(event, acc) {
  switch (event.type) {
    // --- text streaming ---
    case "agent.message": {
      const e = event;
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
      const e = event;
      yield {
        type: "tool-use-done",
        toolName: e.name,
        toolUseId: e.id,
        input: e.input,
        source: { type: "builtin" }
      };
      break;
    }
    case "agent.tool_result": {
      const e = event;
      const output = e.content?.find((b) => b.type === "text");
      yield {
        type: "tool-use-result",
        toolUseId: e.tool_use_id,
        output: output?.type === "text" ? output.text : void 0,
        source: { type: "builtin" }
      };
      break;
    }
    case "agent.mcp_tool_use": {
      const e = event;
      yield {
        type: "tool-use-done",
        toolName: e.name,
        toolUseId: e.id,
        input: e.input,
        source: {
          type: "mcp",
          serverName: e.mcp_server_name ?? ""
        }
      };
      break;
    }
    case "agent.mcp_tool_result": {
      const e = event;
      const output = e.content?.find((b) => b.type === "text");
      yield {
        type: "tool-use-result",
        toolUseId: e.mcp_tool_use_id,
        output: output?.type === "text" ? output.text : void 0,
        source: {
          type: "mcp",
          serverName: ""
        }
      };
      break;
    }
    case "agent.custom_tool_use": {
      const e = event;
      acc.actionsRequired.push({
        type: "tool-confirmation",
        toolUseId: e.id,
        toolName: e.name,
        input: e.input
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
      const e = event;
      yield { type: "status-change", status: "idle" };
      acc.finishReason = mapStopReason(e.stop_reason);
      acc.done = true;
      break;
    }
    case "session.status_terminated": {
      throw new ThalamusError("Session terminated", {
        provider: ANTHROPIC,
        isRetryable: false
      });
    }
    // --- error ---
    case "session.error": {
      const e = event;
      throw mapSessionError(e.error);
    }
    // --- usage ---
    case "span.model_request_end": {
      const e = event;
      if (e.model_usage) {
        acc.usage = {
          inputTokens: e.model_usage.input_tokens,
          outputTokens: e.model_usage.output_tokens,
          totalTokens: e.model_usage.input_tokens + e.model_usage.output_tokens
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
        data: event
      };
      break;
    }
  }
}
async function createClient(config) {
  if ("awsRegion" in config && config.awsRegion) {
    const { AnthropicAws } = await import("@anthropic-ai/aws-sdk");
    return new AnthropicAws({
      awsRegion: config.awsRegion,
      workspaceId: config.awsWorkspaceId
    });
  }
  return new import_sdk.default({ apiKey: config.apiKey });
}
var MAX_RECONNECT_RETRIES = 3;
var AnthropicProvider = class {
  provider = ANTHROPIC;
  runtimeId;
  client;
  config;
  agentId;
  environmentId;
  _recovered;
  constructor(config) {
    this.config = config;
    this.agentId = config.agentId;
    this.environmentId = config.environmentId;
    this.runtimeId = config.agentId;
    if (config.durable && config.onSessionEvents) {
      if (isEdgeObserver(config.durable)) {
        this._recovered = this.recoverFromEdge().catch(() => {
        });
      } else {
        this.recoverActiveSessions().catch(() => {
        });
        this._recovered = Promise.resolve();
      }
    } else {
      this._recovered = Promise.resolve();
    }
  }
  async getClient() {
    this.client ??= await createClient(this.config);
    return this.client;
  }
  send(params) {
    const callbacks = this.config.onSessionEvents ? this.config.onSessionEvents(params.sessionId ?? "<<pending>>") : void 0;
    return createSendResult(this.runStream(params), callbacks, {
      autoStart: !!this.config.onSessionEvents
    });
  }
  async dispatch(client, sessionId, params, signal) {
    const events = buildSendEvents(params);
    const sendParams = { events };
    await client.beta.sessions.events.send(sessionId, sendParams, { signal });
  }
  async getStatus(client, sessionId) {
    const session = await client.beta.sessions.retrieve(sessionId);
    return session.status;
  }
  /**
   * Iterates raw provider events, deduplicates by ID, maps to StreamParts.
   * Shared by both live SSE and historical catch-up paths.
   * Optional onEvent callback fires after each new event (used for checkpointing).
   */
  async *consumeEvents(source, seenIds, acc, onEvent) {
    for await (const raw of source) {
      if (seenIds.has(raw.id)) continue;
      seenIds.add(raw.id);
      yield* mapEvent(raw, acc);
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
  async *resilientObserve(client, sessionId, signal, onConnected, initialSeenIds) {
    const seenIds = initialSeenIds ?? /* @__PURE__ */ new Set();
    const acc = new ResponseAccumulator();
    const backend = this.checkpointBackend;
    const onEvent = backend ? (eventId) => backend.save({
      sessionId,
      provider: "anthropic",
      lastEventId: eventId,
      createdAt: Date.now()
    }) : void 0;
    let retries = 0;
    let connected = false;
    while (retries <= MAX_RECONNECT_RETRIES) {
      try {
        const sseStream = await client.beta.sessions.events.stream(
          sessionId,
          void 0,
          { signal }
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
  async recoverActiveSessions() {
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
            const callbacks = onSessionEvents(checkpoint.sessionId);
            const stream = this.recoverStream(
              client,
              checkpoint,
              status === "running"
            );
            const result = createSendResult(stream, callbacks, {
              autoStart: true
            });
            result.response.catch(async (err) => {
              console.error(
                `[thalamus] recovery stream failed for ${checkpoint.sessionId}:`,
                err instanceof Error ? err.message : err
              );
              await backend.remove(checkpoint.sessionId).catch(() => {
              });
            });
          } else {
            await backend.remove(checkpoint.sessionId);
          }
        } catch {
          await backend.remove(checkpoint.sessionId).catch(() => {
          });
        }
      })
    );
  }
  /**
   * Generates a stream for a recovered session: fetches all historical events,
   * skips ones already delivered (up to checkpoint.lastEventId), then resumes
   * live SSE if the session is still running.
   */
  async *recoverStream(client, checkpoint, stillRunning) {
    const { sessionId, lastEventId } = checkpoint;
    const backend = this.checkpointBackend;
    const seenIds = /* @__PURE__ */ new Set();
    const acc = new ResponseAccumulator();
    const onEvent = backend ? (eventId) => backend.save({
      sessionId,
      provider: "anthropic",
      lastEventId: eventId,
      createdAt: Date.now()
    }) : void 0;
    yield { type: "stream-start", sessionId };
    const sseStream = stillRunning ? await client.beta.sessions.events.stream(sessionId) : void 0;
    const allEvents = await client.beta.sessions.events.list(sessionId);
    let pastCheckpoint = false;
    for await (const raw of allEvents) {
      seenIds.add(raw.id);
      if (!pastCheckpoint) {
        if (raw.id === lastEventId) pastCheckpoint = true;
        continue;
      }
      yield* mapEvent(raw, acc);
      if (onEvent) await onEvent(raw.id);
      if (acc.done) break;
    }
    if (sseStream && !acc.done) {
      yield* this.consumeEvents(sseStream, seenIds, acc, onEvent);
    }
    if (backend) await backend.remove(sessionId);
    yield { type: "finish", response: acc.toResponse(sessionId) };
  }
  /**
   * Recovers sessions via the edge observer path. Queries the edge for
   * active sessions and reconnects to each, flushing buffered events
   * through onSessionEvents callbacks.
   */
  get edgeObserver() {
    return this.config.durable && isEdgeObserver(this.config.durable) ? this.config.durable : null;
  }
  get checkpointBackend() {
    return this.config.durable && !isEdgeObserver(this.config.durable) ? this.config.durable : null;
  }
  async recoverFromEdge() {
    const observer = this.edgeObserver;
    const { onSessionEvents } = this.config;
    if (!observer || !onSessionEvents) return;
    const active = await observer.listActive();
    for (const sessionId of active) {
      const callbacks = onSessionEvents(sessionId);
      const stream = this.edgeRecoverStream(sessionId);
      const result = createSendResult(stream, callbacks, { autoStart: true });
      result.response.catch((err) => {
        console.error(
          `[thalamus] edge recovery failed for ${sessionId}:`,
          err instanceof Error ? err.message : err
        );
      });
    }
  }
  async *edgeRecoverStream(sessionId) {
    const observer = this.edgeObserver;
    const eventStream = observer.events(sessionId);
    const acc = new ResponseAccumulator();
    let hasEvents = false;
    for await (const frame of eventStream) {
      if (!frame.data) continue;
      if (!hasEvents) {
        hasEvents = true;
        yield { type: "stream-start", sessionId };
      }
      const rawEvent = JSON.parse(frame.data);
      yield* mapEvent(rawEvent, acc);
      if (acc.done) break;
    }
    if (!hasEvents) return;
    await observer.stop(sessionId).catch(() => {
    });
    yield { type: "finish", response: acc.toResponse(sessionId) };
  }
  /**
   * Edge observation: SSE runs on the CF Agent, events arrive via WebSocket.
   * The provider dispatches the message directly and reads parsed events
   * from the edge observer's WebSocket feed.
   */
  async *edgeObserve(client, sessionId, params, signal) {
    await this._recovered;
    const observer = this.edgeObserver;
    await observer.observe({
      sessionId,
      streamUrl: `${client.baseURL}/v1/sessions/${sessionId}/events/stream`,
      headers: {
        "x-api-key": client.apiKey ?? "",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "managed-agents-2026-04-01"
      }
    });
    const eventStream = observer.events(sessionId);
    await this.dispatch(client, sessionId, params, signal);
    const acc = new ResponseAccumulator();
    for await (const frame of eventStream) {
      if (signal?.aborted) break;
      if (!frame.data) continue;
      const rawEvent = JSON.parse(frame.data);
      yield* mapEvent(rawEvent, acc);
      if (acc.done) break;
    }
    await observer.stop(sessionId).catch(() => {
    });
    yield { type: "finish", response: acc.toResponse(sessionId) };
  }
  async *runStream(params) {
    try {
      const client = await this.getClient();
      const sessionId = params.sessionId ?? await this.createSession({
        vaultIds: params.vaultIds,
        providerOptions: params.providerOptions
      });
      yield { type: "stream-start", sessionId };
      const signal = params.abortSignal ?? void 0;
      if (this.edgeObserver) {
        yield* this.edgeObserve(client, sessionId, params, signal);
      } else {
        yield* this.resilientObserve(
          client,
          sessionId,
          signal,
          () => this.dispatch(client, sessionId, params, signal)
        );
      }
    } catch (err) {
      const error = mapStreamError(err, params.sessionId);
      yield { type: "error", error };
    }
  }
  async createSession(options) {
    const client = await this.getClient();
    const params = {
      agent: this.agentId,
      environment_id: this.environmentId,
      ...options?.vaultIds?.length ? { vault_ids: options.vaultIds } : {},
      ...options?.providerOptions
    };
    const session = await client.beta.sessions.create(params);
    return session.id;
  }
  async endSession(_sessionId) {
  }
  async createVault(options) {
    const client = await this.getClient();
    const result = await client.beta.vaults.create({
      display_name: options.name,
      metadata: options.metadata
    });
    return new AnthropicVault(result.id, client, this.agentId);
  }
  async getVault(vaultId) {
    const client = await this.getClient();
    await client.beta.vaults.retrieve(vaultId);
    return new AnthropicVault(vaultId, client, this.agentId);
  }
};
function createAnthropicProvider(config) {
  return new AnthropicProvider(config);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createAnthropicProvider,
  toContentBlocks
});
//# sourceMappingURL=index.cjs.map