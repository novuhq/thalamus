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
  isEdgeObserver: () => isEdgeObserver,
  redis: () => redis
});
module.exports = __toCommonJS(durable_exports);

// src/durable/cloudflare.ts
function cloudflare(options) {
  const base = options.url.replace(/\/+$/, "");
  const headers = {
    "Content-Type": "application/json",
    ...options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}
  };
  return {
    webhook: options.webhook,
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

// src/durable/types.ts
function isEdgeObserver(backend) {
  return "observe" in backend && "stop" in backend && !("save" in backend);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  cloudflare,
  isEdgeObserver,
  redis
});
//# sourceMappingURL=index.cjs.map