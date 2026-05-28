export type LogContext = Record<string, unknown> & {
  stage: string;
  provider?: "anthropic" | "openai";
  sessionId?: string;
  runId?: string;
  turnId?: string;
  sequence?: number;
  eventType?: string;
  mode?: "webhook" | "stream";
  durationMs?: number;
  error?: string;
};

export type ThalamusLogger = {
  debug: (msg: string, ctx?: LogContext) => void;
  info: (msg: string, ctx?: LogContext) => void;
  warn: (msg: string, ctx?: LogContext) => void;
  error: (msg: string, ctx?: LogContext) => void;
};

export type ThalamusLoggerInput =
  | false
  | "silent"
  | "debug"
  | ThalamusLogger
  | Partial<ThalamusLogger>;

export type PinoLike = {
  debug: (obj: Record<string, unknown>, msg: string) => void;
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
};

const noop = () => {};

export const silentLogger: ThalamusLogger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};

function bindMethod(
  logger: Partial<ThalamusLogger>,
  level: keyof ThalamusLogger,
): (msg: string, ctx?: LogContext) => void {
  const method = logger[level];
  return method ? method.bind(logger) : noop;
}

function normalizeLogger(logger: Partial<ThalamusLogger>): ThalamusLogger {
  return {
    debug: bindMethod(logger, "debug"),
    info: bindMethod(logger, "info"),
    warn: bindMethod(logger, "warn"),
    error: bindMethod(logger, "error"),
  };
}

export function createConsoleLogger(
  options: { level?: "debug" | "info" } = {},
): ThalamusLogger {
  const minLevel = options.level ?? "debug";
  const levels = { debug: 0, info: 1, warn: 2, error: 3 } as const;
  const min = levels[minLevel];

  function shouldLog(level: keyof typeof levels): boolean {
    return levels[level] >= min;
  }

  function write(
    level: keyof typeof levels,
    msg: string,
    ctx?: LogContext,
  ): void {
    if (!shouldLog(level)) return;
    const prefix = `[thalamus] ${msg}`;
    const payload = ctx ? { ...ctx } : undefined;
    console[level === "debug" ? "debug" : level](prefix, payload ?? "");
  }

  return {
    debug: (msg, ctx) => write("debug", msg, ctx),
    info: (msg, ctx) => write("info", msg, ctx),
    warn: (msg, ctx) => write("warn", msg, ctx),
    error: (msg, ctx) => write("error", msg, ctx),
  };
}

export function adaptPinoLogger(pino: PinoLike): ThalamusLogger {
  return {
    debug: (msg, ctx) => pino.debug(ctx ?? {}, msg),
    info: (msg, ctx) => pino.info(ctx ?? {}, msg),
    warn: (msg, ctx) => pino.warn(ctx ?? {}, msg),
    error: (msg, ctx) => pino.error(ctx ?? {}, msg),
  };
}

export function resolveLogger(input?: ThalamusLoggerInput): ThalamusLogger {
  if (input === undefined || input === false || input === "silent") {
    return silentLogger;
  }
  if (input === "debug") {
    return createConsoleLogger();
  }
  return normalizeLogger(input);
}

export function logErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
