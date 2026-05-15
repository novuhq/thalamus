"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/durable/index.ts
var durable_exports = {};
__export(durable_exports, {
  cloudflare: () => cloudflare,
  redis: () => redis
});
module.exports = __toCommonJS(durable_exports);

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

// src/durable/redis.ts
var DEFAULT_KEY = "thalamus:sessions";
function redis(client, options) {
  const key = options?.key ?? DEFAULT_KEY;
  return {
    async save(checkpoint) {
      await client.hSet(key, checkpoint.sessionId, JSON.stringify(checkpoint));
    },
    async remove(sessionId) {
      await client.hDel(key, sessionId);
    },
    async getActive() {
      const all = await client.hGetAll(key);
      return Object.values(all).map((v) => JSON.parse(v));
    }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  cloudflare,
  redis
});
//# sourceMappingURL=index.cjs.map