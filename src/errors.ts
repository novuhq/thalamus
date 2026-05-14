export class ThalamusError extends Error {
  readonly provider: string;
  readonly isRetryable: boolean;
  override readonly cause?: unknown;

  constructor(
    message: string,
    options: { provider: string; isRetryable: boolean; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "ThalamusError";
    this.provider = options.provider;
    this.isRetryable = options.isRetryable;
    this.cause = options.cause;
  }
}

export class ProviderAuthError extends ThalamusError {
  constructor(message: string, options: { provider: string; cause?: unknown }) {
    super(message, { ...options, isRetryable: false });
    this.name = "ProviderAuthError";
  }
}

export class ProviderRateLimitError extends ThalamusError {
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: { provider: string; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, { ...options, isRetryable: true });
    this.name = "ProviderRateLimitError";
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class ProviderUnavailableError extends ThalamusError {
  constructor(message: string, options: { provider: string; cause?: unknown }) {
    super(message, { ...options, isRetryable: true });
    this.name = "ProviderUnavailableError";
  }
}

export class ProviderResponseError extends ThalamusError {
  constructor(message: string, options: { provider: string; cause?: unknown }) {
    super(message, { ...options, isRetryable: false });
    this.name = "ProviderResponseError";
  }
}

export class SessionExpiredError extends ThalamusError {
  readonly sessionId: string;

  constructor(
    message: string,
    options: { provider: string; sessionId: string; cause?: unknown },
  ) {
    super(message, { ...options, isRetryable: true });
    this.name = "SessionExpiredError";
    this.sessionId = options.sessionId;
  }
}

export class VaultError extends ThalamusError {
  constructor(message: string, options: { provider: string; cause?: unknown }) {
    super(message, { ...options, isRetryable: false });
    this.name = "VaultError";
  }
}

export class VaultNotFoundError extends VaultError {
  readonly vaultId: string;

  constructor(vaultId: string, options: { provider: string; cause?: unknown }) {
    super(`Vault ${vaultId} not found`, options);
    this.name = "VaultNotFoundError";
    this.vaultId = vaultId;
  }
}

export class CredentialExpiredError extends VaultError {
  readonly serverName: string;
  readonly vaultId: string;

  constructor(
    serverName: string,
    vaultId: string,
    options: { provider: string; cause?: unknown },
  ) {
    super(
      `Credential for ${serverName} in vault ${vaultId} is expired with no refresh config`,
      options,
    );
    this.name = "CredentialExpiredError";
    this.serverName = serverName;
    this.vaultId = vaultId;
  }
}

export class AbortedError extends ThalamusError {
  readonly sessionId?: string;

  constructor(options: {
    provider: string;
    sessionId?: string;
    cause?: unknown;
  }) {
    super("Operation aborted", { ...options, isRetryable: false });
    this.name = "AbortedError";
    this.sessionId = options.sessionId;
  }
}

export class McpServerError extends ThalamusError {
  readonly serverName: string;
  readonly statusCode?: number;

  constructor(
    serverName: string,
    options: { provider: string; statusCode?: number; cause?: unknown },
  ) {
    const retryable =
      options.statusCode !== undefined && options.statusCode >= 500;
    super(
      `MCP server ${serverName} error${options.statusCode ? ` (${options.statusCode})` : ""}`,
      { ...options, isRetryable: retryable },
    );
    this.name = "McpServerError";
    this.serverName = serverName;
    this.statusCode = options.statusCode;
  }
}
