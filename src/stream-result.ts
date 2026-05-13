import type {
  Response,
  StreamCallbacks,
  StreamPart,
  StreamResult,
} from "./types";

const CALLBACK_MAP: Record<StreamPart["type"], keyof StreamCallbacks> = {
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

class StreamResultImpl implements StreamResult {
  private _promise: Promise<Response> | null = null;

  constructor(
    private readonly source: AsyncIterable<StreamPart>,
    private readonly callbacks?: StreamCallbacks,
  ) {}

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

export function createStreamResult(
  source: AsyncIterable<StreamPart>,
  callbacks?: StreamCallbacks,
): StreamResult {
  return new StreamResultImpl(source, callbacks);
}
