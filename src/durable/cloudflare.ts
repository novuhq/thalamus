import type { EdgeObserveParams, EdgeObserver, SSEFrame } from "./types";

/**
 * Push-based producer, pull-based consumer. Bridges WebSocket events
 * (which fire whenever) to `for await...of` (which pulls one at a time).
 */
class AsyncQueue<T> implements AsyncIterableIterator<T> {
  private buffer: T[] = [];
  private wake: (() => void) | null = null;
  private done = false;
  private err: Error | null = null;

  push(value: T): void {
    this.buffer.push(value);
    this.notify();
  }

  end(): void {
    this.done = true;
    this.notify();
  }

  fail(error: Error): void {
    this.err = error;
    this.done = true;
    this.notify();
  }

  private notify(): void {
    if (this.wake) {
      const r = this.wake;
      this.wake = null;
      r();
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }

  async next(): Promise<IteratorResult<T>> {
    while (true) {
      if (this.buffer.length > 0)
        return { value: this.buffer.shift() as T, done: false };
      if (this.err) throw this.err;
      if (this.done) return { value: undefined as never, done: true };
      await new Promise<void>((r) => {
        this.wake = r;
      });
    }
  }

  async return(): Promise<IteratorResult<T>> {
    this.done = true;
    return { value: undefined as never, done: true };
  }
}

export interface CloudflareBackendOptions {
  url: string;
  apiKey?: string;
}

/**
 * Creates an edge observer backed by the `thalamus-session-observer`
 * Cloudflare Worker.
 *
 * The Worker's Durable Object opens SSE connections to the provider
 * API on your behalf, forwarding events over WebSocket. Observation
 * survives DO eviction via `runFiber()` + automatic recovery.
 */
export function cloudflare(options: CloudflareBackendOptions): EdgeObserver {
  const base = options.url.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
  };

  const wsBase = base.replace(/^http/, "ws");

  return {
    async observe(params: EdgeObserveParams) {
      const res = await fetch(`${base}/observe`, {
        method: "POST",
        headers,
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        throw new Error(`cloudflare observe failed: ${res.status}`);
      }
    },

    async stop(sessionId: string) {
      const res = await fetch(
        `${base}/observe/${encodeURIComponent(sessionId)}`,
        { method: "DELETE", headers },
      );
      if (!res.ok && res.status !== 404) {
        throw new Error(`cloudflare stop failed: ${res.status}`);
      }
    },

    events(sessionId: string): AsyncIterable<SSEFrame> {
      let wsUrl = `${wsBase}?sessionId=${encodeURIComponent(sessionId)}`;
      if (options.apiKey) {
        wsUrl += `&token=${encodeURIComponent(options.apiKey)}`;
      }
      const ws = new WebSocket(wsUrl);
      const queue = new AsyncQueue<SSEFrame>();

      ws.addEventListener("message", (e: MessageEvent) =>
        queue.push(JSON.parse(String(e.data)) as SSEFrame),
      );
      ws.addEventListener("close", () => queue.end());
      ws.addEventListener("error", () =>
        queue.fail(new Error("WebSocket closed with error")),
      );

      const ready = new Promise<void>((res, rej) => {
        ws.addEventListener("open", () => res(), { once: true });
        ws.addEventListener(
          "error",
          () => rej(new Error("WebSocket connection failed")),
          {
            once: true,
          },
        );
      });

      let connected = false;
      const iter: AsyncIterableIterator<SSEFrame> = {
        [Symbol.asyncIterator]() {
          return iter;
        },
        async next() {
          if (!connected) {
            await ready;
            connected = true;
          }
          return queue.next();
        },
        async return() {
          ws.close();
          return queue.return?.() ?? { value: undefined as never, done: true };
        },
      };
      return iter;
    },
  };
}
