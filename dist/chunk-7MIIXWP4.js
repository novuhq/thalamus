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
var AbortedError = class extends ThalamusError {
  sessionId;
  constructor(options) {
    super("Operation aborted", { ...options, isRetryable: false });
    this.name = "AbortedError";
    this.sessionId = options.sessionId;
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
  AbortedError,
  McpServerError,
  MessageRole,
  ANTHROPIC,
  OPENAI
};
//# sourceMappingURL=chunk-7MIIXWP4.js.map