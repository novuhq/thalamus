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
