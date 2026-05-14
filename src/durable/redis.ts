import type { DurabilityBackend, SessionCheckpoint } from "./types";

/** Minimal subset of `redis` / `ioredis` — pass your own client instance. */
export interface RedisLike {
  hSet(
    key: string,
    field: string,
    value: string,
  ): Promise<number | string | unknown>;
  hDel(key: string, ...fields: string[]): Promise<number | string | unknown>;
  hGetAll(key: string): Promise<Record<string, string>>;
}

const DEFAULT_KEY = "thalamus:sessions";

export function redis(
  client: RedisLike,
  options?: { key?: string },
): DurabilityBackend {
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
      return Object.values(all).map((v) => JSON.parse(v) as SessionCheckpoint);
    },
  };
}
