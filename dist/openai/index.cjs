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
  createOpenAIProvider: () => createOpenAIProvider,
  openaiTransformer: () => openaiTransformer
});
module.exports = __toCommonJS(openai_exports);

// src/openai/openai.provider.ts
var import_openai = __toESM(require("openai"), 1);

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
      const acc = new ResponseAccumulator();
      for await (const rawEvent of rawStream) {
        yield* mapEvent(rawEvent, acc);
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createOpenAIProvider,
  openaiTransformer
});
//# sourceMappingURL=index.cjs.map