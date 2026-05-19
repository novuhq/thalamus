// src/send-result.ts
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
var SendResultImpl = class {
  constructor(source, callbacks, options) {
    this.source = source;
    this.callbacks = callbacks;
    this._sessionId = new Promise((resolve) => {
      this._sessionIdResolve = resolve;
    });
    if (options?.autoStart) {
      this._promise = this.run();
    }
  }
  source;
  callbacks;
  _promise = null;
  _sessionIdResolve;
  _sessionId;
  get sessionId() {
    this._promise ??= this.run();
    return this._sessionId;
  }
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
      if (part.type === "stream-start" && part.sessionId) {
        this._sessionIdResolve(part.sessionId);
      }
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
function createSendResult(source, callbacks, options) {
  return new SendResultImpl(source, callbacks, options);
}

export {
  CALLBACK_MAP,
  createSendResult
};
//# sourceMappingURL=chunk-73H2VIN4.js.map