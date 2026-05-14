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

// src/index.ts
var src_exports = {};
__export(src_exports, {
  ANTHROPIC: () => ANTHROPIC,
  CredentialExpiredError: () => CredentialExpiredError,
  McpServerError: () => McpServerError,
  MessageRole: () => MessageRole,
  OPENAI: () => OPENAI,
  ProviderAuthError: () => ProviderAuthError,
  ProviderRateLimitError: () => ProviderRateLimitError,
  ProviderResponseError: () => ProviderResponseError,
  ProviderUnavailableError: () => ProviderUnavailableError,
  SessionExpiredError: () => SessionExpiredError,
  ThalamusError: () => ThalamusError,
  VaultError: () => VaultError,
  VaultNotFoundError: () => VaultNotFoundError,
  collectStream: () => collectStream,
  createAnthropicProvider: () => createAnthropicProvider,
  createMemoryVaultStore: () => createMemoryVaultStore,
  createOpenAIProvider: () => createOpenAIProvider,
  createStreamResult: () => createStreamResult,
  thalamus: () => thalamus
});
module.exports = __toCommonJS(src_exports);

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
var SessionExpiredError = class extends ThalamusError {
  sessionId;
  constructor(message, options) {
    super(message, { ...options, isRetryable: true });
    this.name = "SessionExpiredError";
    this.sessionId = options.sessionId;
  }
};
var VaultError = class extends ThalamusError {
  constructor(message, options) {
    super(message, { ...options, isRetryable: false });
    this.name = "VaultError";
  }
};
var VaultNotFoundError = class extends VaultError {
  vaultId;
  constructor(vaultId, options) {
    super(`Vault ${vaultId} not found`, options);
    this.name = "VaultNotFoundError";
    this.vaultId = vaultId;
  }
};
var CredentialExpiredError = class extends VaultError {
  serverName;
  vaultId;
  constructor(serverName, vaultId, options) {
    super(
      `Credential for ${serverName} in vault ${vaultId} is expired with no refresh config`,
      options
    );
    this.name = "CredentialExpiredError";
    this.serverName = serverName;
    this.vaultId = vaultId;
  }
};
var McpServerError = class extends ThalamusError {
  serverName;
  statusCode;
  constructor(serverName, options) {
    const retryable = options.statusCode !== void 0 && options.statusCode >= 500;
    super(
      `MCP server ${serverName} error${options.statusCode ? ` (${options.statusCode})` : ""}`,
      { ...options, isRetryable: retryable }
    );
    this.name = "McpServerError";
    this.serverName = serverName;
    this.statusCode = options.statusCode;
  }
};

// src/stream-result.ts
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
var StreamResultImpl = class {
  constructor(source, callbacks) {
    this.source = source;
    this.callbacks = callbacks;
  }
  source;
  callbacks;
  _promise = null;
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
function createStreamResult(source, callbacks) {
  return new StreamResultImpl(source, callbacks);
}

// src/stream-utils.ts
async function collectStream(result) {
  return result;
}

// src/types.ts
var MessageRole = /* @__PURE__ */ ((MessageRole2) => {
  MessageRole2["USER"] = "user";
  MessageRole2["ASSISTANT"] = "assistant";
  MessageRole2["SYSTEM"] = "system";
  return MessageRole2;
})(MessageRole || {});
var ANTHROPIC = "anthropic";
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

// src/vault/memory-vault-store.ts
var counter = 0;
function createMemoryVaultStore() {
  const vaults = /* @__PURE__ */ new Map();
  const credentials = /* @__PURE__ */ new Map();
  return {
    async createVault(options) {
      const record = {
        id: `vlt_mem_${++counter}`,
        name: options.name,
        metadata: options.metadata,
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      vaults.set(record.id, record);
      return { ...record };
    },
    async getVault(vaultId) {
      const vault = vaults.get(vaultId);
      return vault ? { ...vault } : null;
    },
    async updateVaultMetadata(vaultId, metadata) {
      const vault = vaults.get(vaultId);
      if (vault) {
        vault.metadata = { ...vault.metadata, ...metadata };
      }
    },
    async removeVault(vaultId) {
      vaults.delete(vaultId);
      credentials.delete(vaultId);
    },
    async set(vaultId, name, credential) {
      let vaultCreds = credentials.get(vaultId);
      if (!vaultCreds) {
        vaultCreds = /* @__PURE__ */ new Map();
        credentials.set(vaultId, vaultCreds);
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const stored = {
        name,
        type: credential.type,
        credential,
        status: "active",
        expiresAt: credential.type === "oauth" ? credential.expiresAt : void 0,
        createdAt: now,
        updatedAt: now
      };
      vaultCreds.set(name, stored);
    },
    async get(vaultId, name) {
      const stored = credentials.get(vaultId)?.get(name);
      return stored ? { ...stored } : null;
    },
    async getAll(vaultId) {
      const vaultCreds = credentials.get(vaultId);
      if (!vaultCreds) return [];
      return [...vaultCreds.values()].map((c) => ({ ...c }));
    },
    async remove(vaultId, name) {
      credentials.get(vaultId)?.delete(name);
    }
  };
}

// src/anthropic/anthropic.provider.ts
var import_sdk = __toESM(require("@anthropic-ai/sdk"), 1);

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
  }
  async getClient() {
    this.client ??= await createClient(this.config);
    return this.client;
  }
  stream(params, callbacks) {
    return createStreamResult(this.runStream(params), callbacks);
  }
  async *runStream(params) {
    try {
      const client = await this.getClient();
      const sessionId = params.sessionId ?? await this.createSession({
        vaultIds: params.vaultIds,
        providerOptions: params.providerOptions
      });
      yield { type: "stream-start", sessionId };
      const sseStream = await client.beta.sessions.events.stream(sessionId);
      const events = buildSendEvents(params);
      const sendParams = { events };
      await client.beta.sessions.events.send(sessionId, sendParams);
      const acc = new ResponseAccumulator();
      for await (const rawEvent of sseStream) {
        yield* mapEvent(rawEvent, acc);
        if (acc.done) break;
      }
      const response = acc.toResponse(sessionId);
      yield { type: "finish", response };
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

// src/openai/openai.provider.ts
var import_openai = __toESM(require("openai"), 1);

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
function isResponseErrorEvent(e) {
  return typeof e === "object" && e !== null && "type" in e && e.type === "error" && "code" in e;
}
function mapError(error, provider) {
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
var ResponseAccumulator2 = class {
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
function* mapEvent2(event, acc) {
  switch (event.type) {
    // --- lifecycle ---
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
    // --- text streaming ---
    case "response.output_text.delta": {
      acc.content += event.delta;
      yield { type: "text-delta", text: event.delta };
      break;
    }
    // --- refusal ---
    case "response.refusal.delta": {
      acc.finishReason = "refused";
      yield { type: "refusal", text: event.delta };
      break;
    }
    // --- reasoning / thinking ---
    case "response.reasoning_summary_text.delta": {
      yield { type: "thinking", text: event.delta };
      break;
    }
    // --- function / tool calls ---
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
    // --- error ---
    case "error": {
      throw mapError(event, OPENAI);
    }
    // --- escape hatch for everything else ---
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
function buildOpenAIClient(config) {
  if (!("awsRegion" in config) || !config.awsRegion) {
    return new import_openai.default({ apiKey: config.apiKey });
  }
  const baseURL = `https://bedrock-mantle.${config.awsRegion}.api.aws/v1`;
  if ("awsBedrockApiKey" in config && config.awsBedrockApiKey) {
    return new import_openai.default({ baseURL, apiKey: config.awsBedrockApiKey });
  }
  if ("awsCredentials" in config && config.awsCredentials) {
    return new import_openai.default({
      baseURL,
      apiKey: "bedrock-sigv4",
      fetch: createSigV4Fetch({
        region: config.awsRegion,
        credentials: config.awsCredentials
      })
    });
  }
  return new import_openai.default({ baseURL, apiKey: "bedrock" });
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
  constructor(config) {
    this.runtimeId = config.promptId ?? "inline";
    this.model = config.model ?? "gpt-4o";
    this.instructions = config.instructions;
    this.client = buildOpenAIClient(config);
    this.useConversations = !("awsRegion" in config && config.awsRegion);
    this.mcpServers = config.mcpServers ?? [];
    this.vaultStore = config.vaultStore;
  }
  stream(params, callbacks) {
    return createStreamResult(this.runStream(params), callbacks);
  }
  async resolveSessionParams(sessionId) {
    if (this.useConversations) {
      const id = sessionId ?? (await this.client.conversations.create()).id;
      return { conversation: { id } };
    }
    return sessionId ? { previous_response_id: sessionId } : {};
  }
  async *runStream(params) {
    try {
      const sessionParams = await this.resolveSessionParams(params.sessionId);
      const credentials = params.vaultIds?.length ? await this.resolveCredentials(params.vaultIds) : void 0;
      const mcpTools = this.mcpServers.length > 0 ? toMcpTools(this.mcpServers, credentials) : void 0;
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
      const rawStream = await this.client.responses.create({
        model: this.model,
        input,
        stream: true,
        ...this.instructions ? { instructions: this.instructions } : {},
        ...mcpTools ? { tools: mcpTools } : {},
        ...sessionParams,
        ...params.providerOptions
      });
      const acc = new ResponseAccumulator2();
      for await (const rawEvent of rawStream) {
        yield* mapEvent2(rawEvent, acc);
      }
      const response = acc.toResponse();
      yield { type: "finish", response };
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

// src/index.ts
var thalamus = {
  anthropic: createAnthropicProvider,
  openai: createOpenAIProvider
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ANTHROPIC,
  CredentialExpiredError,
  McpServerError,
  MessageRole,
  OPENAI,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
  SessionExpiredError,
  ThalamusError,
  VaultError,
  VaultNotFoundError,
  collectStream,
  createAnthropicProvider,
  createMemoryVaultStore,
  createOpenAIProvider,
  createStreamResult,
  thalamus
});
//# sourceMappingURL=index.cjs.map