import {
  cloudflare
} from "../chunk-XSDMRFL4.js";
import {
  isEdgeObserver
} from "../chunk-YFRF7YPZ.js";

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
export {
  cloudflare,
  isEdgeObserver,
  redis
};
//# sourceMappingURL=index.js.map