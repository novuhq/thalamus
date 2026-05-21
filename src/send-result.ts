import type {
  Response,
  SendResult,
  StreamCallbacks,
  StreamPart,
} from "./types";

export const CALLBACK_MAP: Record<StreamPart["type"], keyof StreamCallbacks> = {
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
  "provider-event": "onProviderEvent",
};

export interface SendResultOptions {
  autoStart?: boolean;
}

class SendResultImpl implements SendResult {
  private _promise: Promise<Response> | null = null;
  private _sessionIdResolve!: (id: string) => void;
  private readonly _sessionId: Promise<string>;

  constructor(
    private readonly source: AsyncIterable<StreamPart>,
    readonly runId: string,
    private readonly callbacks?: StreamCallbacks,
    options?: SendResultOptions,
  ) {
    this._sessionId = new Promise<string>((resolve) => {
      this._sessionIdResolve = resolve;
    });

    if (options?.autoStart) {
      this._promise = this.run();
    }
  }

  get sessionId(): Promise<string> {
    this._promise ??= this.run();
    return this._sessionId;
  }

  get response(): Promise<Response> {
    this._promise ??= this.run();
    return this._promise;
  }

  // biome-ignore lint/suspicious/noThenProperty: intentional PromiseLike implementation
  then<TResult1 = Response, TResult2 = never>(
    onfulfilled?:
      | ((value: Response) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.response.then(onfulfilled, onrejected);
  }

  async text(): Promise<string> {
    return (await this.response).content;
  }

  private async run(): Promise<Response> {
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

  private dispatch(part: StreamPart): void {
    if (!this.callbacks) return;
    this.callbacks.onPart?.(part);
    const key = CALLBACK_MAP[part.type];
    const cb = this.callbacks[key] as ((part: StreamPart) => void) | undefined;
    if (cb) cb(part);
  }
}

export function createSendResult(
  source: AsyncIterable<StreamPart>,
  runId: string,
  callbacks?: StreamCallbacks,
  options?: SendResultOptions,
): SendResult {
  return new SendResultImpl(source, runId, callbacks, options);
}
