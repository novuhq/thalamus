// src/durable/cloudflare.ts
var AsyncQueue = class {
  buffer = [];
  wake = null;
  done = false;
  err = null;
  push(value) {
    this.buffer.push(value);
    this.notify();
  }
  end() {
    this.done = true;
    this.notify();
  }
  fail(error) {
    this.err = error;
    this.done = true;
    this.notify();
  }
  notify() {
    if (this.wake) {
      const r = this.wake;
      this.wake = null;
      r();
    }
  }
  [Symbol.asyncIterator]() {
    return this;
  }
  async next() {
    while (true) {
      if (this.buffer.length > 0)
        return { value: this.buffer.shift(), done: false };
      if (this.err) throw this.err;
      if (this.done) return { value: void 0, done: true };
      await new Promise((r) => {
        this.wake = r;
      });
    }
  }
  async return() {
    this.done = true;
    return { value: void 0, done: true };
  }
};
function cloudflare(options) {
  const base = options.url.replace(/\/+$/, "");
  const headers = {
    "Content-Type": "application/json",
    ...options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}
  };
  const wsBase = base.replace(/^http/, "ws");
  return {
    async observe(params) {
      const res = await fetch(`${base}/observe`, {
        method: "POST",
        headers,
        body: JSON.stringify(params)
      });
      if (!res.ok) {
        throw new Error(`cloudflare observe failed: ${res.status}`);
      }
    },
    async stop(sessionId) {
      const res = await fetch(
        `${base}/observe/${encodeURIComponent(sessionId)}`,
        { method: "DELETE", headers }
      );
      if (!res.ok && res.status !== 404) {
        throw new Error(`cloudflare stop failed: ${res.status}`);
      }
    },
    async listActive() {
      try {
        const res = await fetch(`${base}/active-sessions`, { headers });
        if (!res.ok) return [];
        return await res.json();
      } catch {
        return [];
      }
    },
    events(sessionId) {
      let wsUrl = `${wsBase}?sessionId=${encodeURIComponent(sessionId)}`;
      if (options.apiKey) {
        wsUrl += `&token=${encodeURIComponent(options.apiKey)}`;
      }
      const ws = new WebSocket(wsUrl);
      const queue = new AsyncQueue();
      ws.addEventListener("message", (e) => {
        const parsed = JSON.parse(String(e.data));
        if (typeof parsed.type === "string" && parsed.type.startsWith("cf_agent_"))
          return;
        queue.push(parsed);
      });
      ws.addEventListener("close", () => {
        queue.end();
      });
      ws.addEventListener("error", () => {
        queue.fail(new Error("WebSocket closed with error"));
      });
      const ready = new Promise((res, rej) => {
        const timer = setTimeout(() => {
          rej(new Error("WebSocket connection timeout"));
        }, 15e3);
        ws.addEventListener(
          "open",
          () => {
            clearTimeout(timer);
            res();
          },
          { once: true }
        );
        ws.addEventListener(
          "error",
          () => {
            clearTimeout(timer);
            rej(new Error("WebSocket connection failed"));
          },
          { once: true }
        );
      });
      let connected = false;
      const iter = {
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
          return queue.return?.() ?? { value: void 0, done: true };
        }
      };
      return iter;
    }
  };
}

export {
  cloudflare
};
//# sourceMappingURL=chunk-3AFTTNQC.js.map