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

// src/types.ts
var MessageRole = /* @__PURE__ */ ((MessageRole2) => {
  MessageRole2["USER"] = "user";
  MessageRole2["ASSISTANT"] = "assistant";
  MessageRole2["SYSTEM"] = "system";
  return MessageRole2;
})(MessageRole || {});
var ANTHROPIC = "anthropic";
var OPENAI = "openai";

export {
  ThalamusError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderUnavailableError,
  ProviderResponseError,
  SessionExpiredError,
  VaultError,
  VaultNotFoundError,
  CredentialExpiredError,
  McpServerError,
  createStreamResult,
  MessageRole,
  ANTHROPIC,
  OPENAI
};
//# sourceMappingURL=chunk-LQAFAVC6.js.map