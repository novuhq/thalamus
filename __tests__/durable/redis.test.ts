import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RedisLike } from "../../src/durable/redis.js";
import { redis } from "../../src/durable/redis.js";
import type { SessionCheckpoint } from "../../src/durable/types.js";

function createMockRedis(): RedisLike & {
  _store: Record<string, Record<string, string>>;
} {
  const _store: Record<string, Record<string, string>> = {};
  return {
    _store,
    async hSet(key: string, field: string, value: string) {
      _store[key] ??= {};
      _store[key][field] = value;
      return 1;
    },
    async hDel(key: string, ...fields: string[]) {
      let deleted = 0;
      for (const f of fields) {
        if (_store[key]?.[f]) {
          delete _store[key][f];
          deleted++;
        }
      }
      return deleted;
    },
    async hGetAll(key: string) {
      return _store[key] ?? {};
    },
  };
}

describe("redis() durability backend", () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  const checkpoint: SessionCheckpoint = {
    sessionId: "sess_1",
    provider: "anthropic",
    lastEventId: "evt_10",
    createdAt: 1000,
  };

  beforeEach(() => {
    mockRedis = createMockRedis();
  });

  it("saves as JSON in the default hash key", async () => {
    const backend = redis(mockRedis);
    await backend.save(checkpoint);
    expect(mockRedis._store["thalamus:sessions"]["sess_1"]).toBe(
      JSON.stringify(checkpoint),
    );
  });

  it("retrieves active checkpoints", async () => {
    const backend = redis(mockRedis);
    await backend.save(checkpoint);
    const active = await backend.getActive();
    expect(active).toEqual([checkpoint]);
  });

  it("removes a checkpoint", async () => {
    const backend = redis(mockRedis);
    await backend.save(checkpoint);
    await backend.remove("sess_1");
    const active = await backend.getActive();
    expect(active).toEqual([]);
  });

  it("supports custom key via options", async () => {
    const backend = redis(mockRedis, { key: "custom:sessions" });
    await backend.save(checkpoint);
    expect(mockRedis._store["custom:sessions"]["sess_1"]).toBeDefined();
    expect(mockRedis._store["thalamus:sessions"]).toBeUndefined();
  });

  it("preserves metadata through round-trip", async () => {
    const backend = redis(mockRedis);
    const cpWithMeta: SessionCheckpoint = {
      ...checkpoint,
      metadata: { responseId: "resp_abc" },
    };
    await backend.save(cpWithMeta);
    const active = await backend.getActive();
    expect(active[0].metadata).toEqual({ responseId: "resp_abc" });
  });
});
