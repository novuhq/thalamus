import {
  ANTHROPIC,
  AbortedError,
  SessionExpiredError,
  ThalamusError,
  createSendResult
} from "./chunk-U2SEW5AP.js";

// src/anthropic/anthropic.provider.ts
import Anthropic, { APIError, APIUserAbortError } from "@anthropic-ai/sdk";

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
  if (err instanceof APIUserAbortError) {
    return new AbortedError({ provider: ANTHROPIC, sessionId, cause: err });
  }
  if (sessionId && err instanceof APIError) {
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
  if (err instanceof APIUserAbortError) return false;
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
  return new Anthropic({ apiKey: config.apiKey });
}
var MAX_RECONNECT_RETRIES = 3;
var AnthropicProvider = class {
  provider = ANTHROPIC;
  runtimeId;
  client;
  config;
  agentId;
  environmentId;
  constructor(config) {
    this.config = config;
    this.agentId = config.agentId;
    this.environmentId = config.environmentId;
    this.runtimeId = config.agentId;
    if (config.durable && config.onSessionEvents) {
      this.recoverActiveSessions().catch(() => {
      });
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
  async *observe(client, sessionId, signal) {
    const sseStream = await client.beta.sessions.events.stream(
      sessionId,
      void 0,
      { signal }
    );
    const acc = new ResponseAccumulator();
    for await (const rawEvent of sseStream) {
      yield* mapEvent(rawEvent, acc);
      if (acc.done) break;
    }
    const response = acc.toResponse(sessionId);
    yield { type: "finish", response };
  }
  async *fetchMissedEvents(client, sessionId, pageCursor) {
    const page = await client.beta.sessions.events.list(sessionId, {
      ...pageCursor ? { page: pageCursor } : {}
    });
    const acc = new ResponseAccumulator();
    for await (const event of page) {
      yield* mapEvent(event, acc);
      if (acc.done) break;
    }
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
    const durable = this.config.durable;
    const onEvent = durable ? (eventId) => durable.save({
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
              if (durable) await durable.remove(sessionId);
              yield { type: "finish", response: acc.toResponse(sessionId) };
              return;
            }
          } catch {
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
  async recoverActiveSessions() {
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
              await durable.remove(checkpoint.sessionId).catch(() => {
              });
            });
          } else {
            await durable.remove(checkpoint.sessionId);
          }
        } catch {
          await durable.remove(checkpoint.sessionId).catch(() => {
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
    const durable = this.config.durable;
    const seenIds = /* @__PURE__ */ new Set();
    const acc = new ResponseAccumulator();
    const onEvent = durable ? (eventId) => durable.save({
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
    if (durable) await durable.remove(sessionId);
    yield { type: "finish", response: acc.toResponse(sessionId) };
  }
  /**
   * Edge observation: SSE runs on the CF Agent, events arrive via WebSocket.
   * The provider dispatches the message directly and reads parsed events
   * from the edge observer's WebSocket feed.
   */
  async *edgeObserve(client, sessionId, params, signal) {
    const observer = this.config.edgeObserver;
    const eventStream = observer.events(sessionId);
    await observer.observe({
      sessionId,
      streamUrl: `${client.baseURL}/v1/sessions/${sessionId}/events/stream`,
      headers: {
        "x-api-key": client.apiKey ?? "",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "managed-agents-2026-04-01"
      }
    });
    await this.dispatch(client, sessionId, params, signal);
    const acc = new ResponseAccumulator();
    for await (const frame of eventStream) {
      if (signal?.aborted) break;
      if (!frame.data) continue;
      const rawEvent = JSON.parse(frame.data);
      yield* mapEvent(rawEvent, acc);
      if (acc.done) break;
    }
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
      if (this.config.edgeObserver) {
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

export {
  toContentBlocks,
  createAnthropicProvider
};
//# sourceMappingURL=chunk-VUMWMBZB.js.map