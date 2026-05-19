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

// src/openai/index.ts
var openai_exports = {};
__export(openai_exports, {
  OpenAIResponseAccumulator: () => ResponseAccumulator,
  createOpenAIProvider: () => createOpenAIProvider,
  mapOpenAIError: () => mapError,
  mapOpenAIEvent: () => mapEvent,
  openaiTransformer: () => openaiTransformer
});
module.exports = __toCommonJS(openai_exports);

// src/openai/openai.provider.ts
var import_openai2 = __toESM(require("openai"), 1);

// src/durable/types.ts
function isEdgeObserver(backend) {
  return "observe" in backend && "stop" in backend && !("save" in backend);
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
var ProviderAuthError = class extends ThalamusError {
  constructor(message, options) {
    super(message, { ...options, isRetryable: false });
    this.name = "ProviderAuthError";
  }
};
var ProviderRateLimitError = class extends ThalamusError {
  retryAfterMs;
  constructor(message, options) {
    super(message, { ...options, isRetryable: true });
    this.name = "ProviderRateLimitError";
    this.retryAfterMs = options.retryAfterMs;
  }
};
var ProviderUnavailableError = class extends ThalamusError {
  constructor(message, options) {
    super(message, { ...options, isRetryable: true });
    this.name = "ProviderUnavailableError";
  }
};
var ProviderResponseError = class extends ThalamusError {
  constructor(message, options) {
    super(message, { ...options, isRetryable: false });
    this.name = "ProviderResponseError";
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
var OPENAI = "openai";

// src/vault/local-vault.ts
var LocalVault = class {
  id;
  provider;
  store;
  constructor(id, provider, store) {
    this.id = id;
    this.provider = provider;
    this.store = store;
  }
  async add(name, credential) {
    await this.store.set(this.id, name, credential);
  }
  async update(name, credential) {
    await this.store.set(this.id, name, credential);
  }
  async remove(name) {
    await this.store.remove(this.id, name);
  }
  async list() {
    const all = await this.store.getAll(this.id);
    return all.map((c) => ({
      name: c.name,
      type: c.type,
      status: c.status,
      expiresAt: c.expiresAt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt
    }));
  }
  async destroy() {
    await this.store.removeVault(this.id);
  }
};

// src/openai/openai.transformer.ts
var openaiTransformer = {
  toInput(messages) {
    return messages.map((msg) => {
      const role = msg.role === "user" /* USER */ ? "user" : msg.role === "system" /* SYSTEM */ ? "system" : "assistant";
      if (typeof msg.content === "string")
        return { role, content: msg.content };
      const parts = [];
      for (const part of msg.content) {
        switch (part.type) {
          case "text":
            parts.push({ type: "input_text", text: part.text });
            break;
          case "image-url":
            parts.push({ type: "input_image", image_url: part.url });
            break;
          case "image":
            parts.push({
              type: "input_image",
              image_url: `data:${part.mediaType};base64,${part.data}`
            });
            break;
          case "file":
            parts.push({
              type: "input_file",
              file_data: `data:${part.mediaType};base64,${part.data}`,
              ...part.name ? { filename: part.name } : {}
            });
            break;
        }
      }
      return { role, content: parts };
    });
  }
};

// src/openai/openai-parser.ts
var import_openai = require("openai");
function isResponseErrorEvent(e) {
  return typeof e === "object" && e !== null && "type" in e && e.type === "error" && "code" in e;
}
function mapError(error, provider) {
  if (error instanceof import_openai.APIUserAbortError) {
    return new AbortedError({ provider, cause: error });
  }
  const msg = error instanceof Error ? error.message : String(error);
  const code = error instanceof import_openai.APIError ? error.code ?? "" : isResponseErrorEvent(error) ? error.code ?? "" : "";
  if (code === "invalid_api_key" || msg.toLowerCase().includes("unauthorized")) {
    return new ProviderAuthError(msg, { provider, cause: error });
  }
  if (code === "rate_limit_exceeded" || msg.toLowerCase().includes("rate limit")) {
    return new ProviderRateLimitError(msg, { provider, cause: error });
  }
  if (msg.toLowerCase().includes("unavailable") || msg.toLowerCase().includes("503")) {
    return new ProviderUnavailableError(msg, { provider, cause: error });
  }
  return new ProviderResponseError(msg, { provider, cause: error });
}
var ResponseAccumulator = class {
  content = "";
  sessionId;
  conversationId;
  finishReason = "stop";
  usage;
  actionsRequired = [];
  toResponse() {
    return {
      content: this.content,
      sessionId: this.conversationId ?? this.sessionId,
      finishReason: this.finishReason,
      usage: this.usage,
      actionsRequired: this.actionsRequired.length > 0 ? this.actionsRequired : void 0
    };
  }
};
function* mapEvent(event, acc) {
  switch (event.type) {
    case "response.created": {
      acc.sessionId = event.response.id;
      acc.conversationId = event.response.conversation?.id;
      yield {
        type: "stream-start",
        sessionId: acc.conversationId ?? acc.sessionId
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
          totalTokens: event.response.usage.total_tokens
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
        { provider: OPENAI, isRetryable: false }
      );
    }
    case "response.incomplete": {
      acc.finishReason = "length";
      break;
    }
    case "response.output_text.delta": {
      acc.content += event.delta;
      yield { type: "text-delta", text: event.delta };
      break;
    }
    case "response.refusal.delta": {
      acc.finishReason = "refused";
      yield { type: "refusal", text: event.delta };
      break;
    }
    case "response.reasoning_summary_text.delta": {
      yield { type: "thinking", text: event.delta };
      break;
    }
    case "response.output_item.added": {
      const e = event;
      if (e.item.type === "function_call") {
        yield {
          type: "tool-use-start",
          toolName: e.item.name,
          toolUseId: e.item.call_id,
          source: { type: "builtin" }
        };
      } else if (e.item.type === "mcp_call") {
        const item = e.item;
        yield {
          type: "tool-use-start",
          toolName: item.name,
          toolUseId: item.id,
          source: { type: "mcp", serverName: item.server_label }
        };
      }
      break;
    }
    case "response.function_call_arguments.delta": {
      yield {
        type: "tool-use-delta",
        toolUseId: event.item_id,
        argumentsDelta: event.delta
      };
      break;
    }
    case "response.mcp_call_arguments.delta": {
      const e = event;
      yield {
        type: "tool-use-delta",
        toolUseId: e.item_id,
        argumentsDelta: e.delta
      };
      break;
    }
    case "response.output_item.done": {
      const e = event;
      if (e.item.type === "function_call") {
        yield {
          type: "tool-use-done",
          toolName: e.item.name,
          toolUseId: e.item.call_id,
          input: JSON.parse(e.item.arguments || "{}"),
          source: { type: "builtin" }
        };
      } else if (e.item.type === "mcp_list_tools") {
        const item = e.item;
        yield {
          type: "mcp-tools-discovered",
          serverName: item.server_label,
          tools: (item.tools ?? []).map((t) => ({
            name: t.name,
            description: t.description ?? void 0,
            inputSchema: t.input_schema
          }))
        };
      } else if (e.item.type === "mcp_call") {
        const item = e.item;
        yield {
          type: "tool-use-done",
          toolName: item.name,
          toolUseId: item.id,
          input: JSON.parse(item.arguments || "{}"),
          source: { type: "mcp", serverName: item.server_label }
        };
        yield {
          type: "tool-use-result",
          toolUseId: item.id,
          output: item.output ?? void 0,
          source: { type: "mcp", serverName: item.server_label }
        };
      } else if (e.item.type === "mcp_approval_request") {
        const item = e.item;
        acc.finishReason = "requires-action";
        acc.actionsRequired.push({
          type: "mcp-approval",
          toolUseId: item.id,
          toolName: item.name,
          serverName: item.server_label,
          input: JSON.parse(item.arguments || "{}")
        });
      }
      break;
    }
    case "error": {
      throw mapError(event, OPENAI);
    }
    default: {
      yield {
        type: "provider-event",
        provider: OPENAI,
        event: event.type,
        data: event
      };
      break;
    }
  }
}

// src/openai/sigv4-fetch.ts
function createSigV4Fetch(options) {
  const { region, credentials } = options;
  return async (input, init) => {
    let SignatureV4;
    let Sha256;
    try {
      SignatureV4 = (await import(
        /* webpackIgnore: true */
        "@smithy/signature-v4"
      )).SignatureV4;
      Sha256 = (await import(
        /* webpackIgnore: true */
        "@aws-crypto/sha256-js"
      )).Sha256;
    } catch {
      throw new Error(
        "SigV4 auth requires @smithy/signature-v4 and @aws-crypto/sha256-js. Install them: pnpm add @smithy/signature-v4 @aws-crypto/sha256-js"
      );
    }
    const signer = new SignatureV4({
      service: "bedrock",
      region,
      credentials,
      sha256: Sha256
    });
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    );
    const body = init?.body ? String(init.body) : void 0;
    const headers = {};
    if (init?.headers) {
      const h = init.headers;
      if (h instanceof Headers) {
        h.forEach((v, k) => {
          headers[k] = v;
        });
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) headers[k] = v;
      } else {
        Object.assign(headers, h);
      }
    }
    const signed = await signer.sign({
      method: init?.method ?? "GET",
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : void 0,
      path: url.pathname + url.search,
      headers: { ...headers, host: url.host },
      body
    });
    return globalThis.fetch(input, {
      ...init,
      headers: signed.headers
    });
  };
}

// src/openai/openai.provider.ts
function isTransientStreamError(err, signal) {
  if (signal?.aborted) return false;
  if (err instanceof import_openai2.APIUserAbortError) return false;
  if (err instanceof ThalamusError) return false;
  if (err instanceof import_openai2.APIError && err.status >= 400 && err.status < 500) {
    return false;
  }
  return true;
}
function mapApprovalPolicy(policy) {
  if (!policy || typeof policy === "string") return policy;
  return { never: { tool_names: policy.except } };
}
function toMcpTools(servers, credentials) {
  return servers.map((server) => {
    const tool = {
      type: "mcp",
      server_label: server.name,
      server_url: server.url
    };
    const cred = credentials?.get(server.name);
    if (cred) {
      tool.authorization = cred.type === "bearer" ? cred.token : cred.accessToken;
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
var MAX_RECONNECT_RETRIES = 3;
function buildOpenAIClient(config) {
  if (!("awsRegion" in config) || !config.awsRegion) {
    return new import_openai2.default({ apiKey: config.apiKey });
  }
  const baseURL = `https://bedrock-mantle.${config.awsRegion}.api.aws/v1`;
  if ("awsBedrockApiKey" in config && config.awsBedrockApiKey) {
    return new import_openai2.default({ baseURL, apiKey: config.awsBedrockApiKey });
  }
  if ("awsCredentials" in config && config.awsCredentials) {
    return new import_openai2.default({
      baseURL,
      apiKey: "bedrock-sigv4",
      fetch: createSigV4Fetch({
        region: config.awsRegion,
        credentials: config.awsCredentials
      })
    });
  }
  return new import_openai2.default({ baseURL, apiKey: "bedrock" });
}
var OpenAIProvider = class {
  provider = OPENAI;
  runtimeId;
  client;
  model;
  instructions;
  useConversations;
  mcpServers;
  vaultStore;
  onSessionEvents;
  config;
  get edgeObserver() {
    return this.config.durable && isEdgeObserver(this.config.durable) ? this.config.durable : null;
  }
  get checkpointBackend() {
    return this.config.durable && !isEdgeObserver(this.config.durable) ? this.config.durable : null;
  }
  constructor(config) {
    this.config = config;
    this.runtimeId = config.promptId ?? "inline";
    this.model = config.model ?? "gpt-4o";
    this.instructions = config.instructions;
    this.client = buildOpenAIClient(config);
    this.useConversations = !("awsRegion" in config && config.awsRegion);
    this.mcpServers = config.mcpServers ?? [];
    this.vaultStore = config.vaultStore;
    this.onSessionEvents = config.onSessionEvents;
    if (config.durable && config.onSessionEvents && !isEdgeObserver(config.durable)) {
      this.recoverActiveSessions().catch(() => {
      });
    }
  }
  send(params) {
    const callbacks = this.onSessionEvents ? this.onSessionEvents(params.sessionId ?? "<<pending>>") : void 0;
    return createSendResult(this.runStream(params), callbacks, {
      autoStart: !!this.onSessionEvents
    });
  }
  async resolveSessionParams(sessionId) {
    if (this.useConversations) {
      const id = sessionId ?? (await this.client.conversations.create()).id;
      return { conversation: { id } };
    }
    return sessionId ? { previous_response_id: sessionId } : {};
  }
  buildInput(params) {
    let input = openaiTransformer.toInput(
      params.messages
    );
    if (params.toolResults?.length) {
      const toolInputs = params.toolResults.map((tr) => {
        if (tr.approved !== void 0) {
          return {
            type: "mcp_approval_response",
            approval_request_id: tr.toolUseId,
            approve: tr.approved
          };
        }
        return {
          type: "function_call_output",
          call_id: tr.toolUseId,
          output: tr.output ?? ""
        };
      });
      input = [...toolInputs, ...input];
    }
    return input;
  }
  async *dispatchAndObserve(params, sessionParams, mcpTools, signal) {
    const input = this.buildInput(params);
    const rawStream = await this.client.responses.create(
      {
        model: this.model,
        input,
        stream: true,
        ...this.instructions ? { instructions: this.instructions } : {},
        ...mcpTools ? { tools: mcpTools } : {},
        ...sessionParams,
        ...params.providerOptions
      },
      { signal }
    );
    const acc = new ResponseAccumulator();
    for await (const rawEvent of rawStream) {
      yield* mapEvent(rawEvent, acc);
    }
    const response = acc.toResponse();
    yield { type: "finish", response };
  }
  async *resumeObservation(responseId, afterSequenceNumber, signal) {
    const rawStream = await this.client.responses.retrieve(
      responseId,
      {
        stream: true,
        ...afterSequenceNumber >= 0 ? { starting_after: afterSequenceNumber } : {}
      },
      { signal }
    );
    yield* rawStream;
  }
  async getStatus(responseId) {
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
  async *resilientDispatchAndObserve(params, sessionParams, mcpTools, signal) {
    const acc = new ResponseAccumulator();
    const backend = this.checkpointBackend;
    const input = this.buildInput(params);
    let lastSequenceNumber = -1;
    let responseId;
    let retries = 0;
    const createParams = {
      model: this.model,
      input,
      ...this.instructions ? { instructions: this.instructions } : {},
      ...mcpTools ? { tools: mcpTools } : {},
      ...sessionParams,
      ...params.providerOptions
    };
    while (retries <= MAX_RECONNECT_RETRIES) {
      try {
        let rawStream;
        if (responseId) {
          rawStream = this.resumeObservation(
            responseId,
            lastSequenceNumber,
            signal
          );
        } else {
          rawStream = await this.client.responses.create(
            {
              ...createParams,
              stream: true,
              ...backend ? { background: true } : {}
            },
            { signal }
          );
        }
        for await (const rawEvent of rawStream) {
          if ("sequence_number" in rawEvent && typeof rawEvent.sequence_number === "number") {
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
              metadata: { responseId }
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
  async recoverActiveSessions() {
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
          if (status === "cancelled" || status === "failed" || status === "incomplete") {
            await backend.remove(checkpoint.sessionId);
            return;
          }
          const callbacks = onSessionEvents(checkpoint.sessionId);
          const stream = this.recoverStream(checkpoint, responseId);
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
        } catch (err) {
          console.error(
            `[thalamus] recovery failed for ${checkpoint.sessionId}:`,
            err instanceof Error ? err.message : err
          );
          await backend.remove(checkpoint.sessionId).catch(() => {
          });
        }
      })
    );
  }
  /**
   * Generates a stream for a recovered session: resumes observation from the
   * last known sequence number, deduplicates, and checkpoints as it goes.
   * Requires the original response to have been created with `background: true`.
   */
  async *recoverStream(checkpoint, responseId) {
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
          lastSequenceNumber
        );
        for await (const rawEvent of rawStream) {
          if ("sequence_number" in rawEvent && typeof rawEvent.sequence_number === "number") {
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
              metadata: { responseId }
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
   * Edge observation: dispatch via background mode, SSE runs on the CF Worker DO,
   * events delivered via webhook. Provider just sets up and returns.
   */
  async *edgeObserve(params, sessionParams, mcpTools, signal) {
    const observer = this.edgeObserver;
    const input = this.buildInput(params);
    const initStream = await this.client.responses.create(
      {
        model: this.model,
        input,
        stream: true,
        background: true,
        ...this.instructions ? { instructions: this.instructions } : {},
        ...mcpTools ? { tools: mcpTools } : {},
        ...sessionParams,
        ...params.providerOptions
      },
      { signal }
    );
    let responseId;
    let lastSeqNo = -1;
    for await (const event of initStream) {
      if ("sequence_number" in event && typeof event.sequence_number === "number") {
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
        { provider: OPENAI, isRetryable: false }
      );
    }
    const startingAfter = lastSeqNo >= 0 ? `&starting_after=${lastSeqNo}` : "";
    await observer.observe({
      sessionId: responseId,
      streamUrl: `${this.client.baseURL}/responses/${responseId}?stream=true${startingAfter}`,
      headers: {
        Authorization: `Bearer ${this.client.apiKey}`
      },
      provider: "openai",
      webhook: {
        ...observer.webhook,
        metadata: params.webhookMetadata
      }
    });
  }
  async *runStream(params) {
    try {
      const sessionParams = await this.resolveSessionParams(params.sessionId);
      const credentials = params.vaultIds?.length ? await this.resolveCredentials(params.vaultIds) : void 0;
      const mcpTools = this.mcpServers.length > 0 ? toMcpTools(this.mcpServers, credentials) : void 0;
      const signal = params.abortSignal ?? void 0;
      if (this.edgeObserver) {
        yield* this.edgeObserve(params, sessionParams, mcpTools, signal);
      } else {
        yield* this.resilientDispatchAndObserve(
          params,
          sessionParams,
          mcpTools,
          signal
        );
      }
    } catch (err) {
      const mapped = err instanceof ThalamusError ? err : mapError(err, OPENAI);
      yield { type: "error", error: mapped };
    }
  }
  async createVault(options) {
    if (!this.vaultStore) {
      throw new ThalamusError(
        "Pass a vaultStore to createOpenAIProvider() to use vault operations",
        {
          provider: OPENAI,
          isRetryable: false
        }
      );
    }
    const record = await this.vaultStore.createVault(options);
    return new LocalVault(record.id, OPENAI, this.vaultStore);
  }
  async getVault(vaultId) {
    if (!this.vaultStore) {
      throw new ThalamusError(
        "vaultStore is required for OpenAI vault support",
        {
          provider: OPENAI,
          isRetryable: false
        }
      );
    }
    const record = await this.vaultStore.getVault(vaultId);
    if (!record) {
      throw new ThalamusError(`Vault not found: ${vaultId}`, {
        provider: OPENAI,
        isRetryable: false
      });
    }
    return new LocalVault(record.id, OPENAI, this.vaultStore);
  }
  async resolveCredentials(vaultIds) {
    if (!this.vaultStore) {
      throw new ThalamusError(
        "vaultStore is required to resolve vault credentials",
        { provider: OPENAI, isRetryable: false }
      );
    }
    const merged = /* @__PURE__ */ new Map();
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
  async createSession(_options) {
    return crypto.randomUUID();
  }
  async endSession(_sessionId) {
  }
};
function createOpenAIProvider(config) {
  return new OpenAIProvider(config);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  OpenAIResponseAccumulator,
  createOpenAIProvider,
  mapOpenAIError,
  mapOpenAIEvent,
  openaiTransformer
});
//# sourceMappingURL=index.cjs.map