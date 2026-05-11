export class ThalamusError extends Error {
  readonly provider: string;
  readonly isRetryable: boolean;
  override readonly cause?: unknown;

  constructor(
    message: string,
    options: { provider: string; isRetryable: boolean; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = 'ThalamusError';
    this.provider = options.provider;
    this.isRetryable = options.isRetryable;
    this.cause = options.cause;
  }
}

export class ProviderAuthError extends ThalamusError {
  constructor(message: string, options: { provider: string; cause?: unknown }) {
    super(message, { ...options, isRetryable: false });
    this.name = 'ProviderAuthError';
  }
}

export class ProviderRateLimitError extends ThalamusError {
  readonly retryAfterMs?: number;

  constructor(message: string, options: { provider: string; retryAfterMs?: number; cause?: unknown }) {
    super(message, { ...options, isRetryable: true });
    this.name = 'ProviderRateLimitError';
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class ProviderUnavailableError extends ThalamusError {
  constructor(message: string, options: { provider: string; cause?: unknown }) {
    super(message, { ...options, isRetryable: true });
    this.name = 'ProviderUnavailableError';
  }
}

export class ProviderResponseError extends ThalamusError {
  constructor(message: string, options: { provider: string; cause?: unknown }) {
    super(message, { ...options, isRetryable: false });
    this.name = 'ProviderResponseError';
  }
}
