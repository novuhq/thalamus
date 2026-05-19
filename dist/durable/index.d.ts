export { C as CloudflareBackendOptions, a as CloudflareEdgeObserver, W as WebhookConfig, c as cloudflare } from '../cloudflare-CiVgvda3.js';
import { b as DurabilityBackend } from '../types-BJUMp1Dw.js';
export { D as DurableBackend, E as EdgeObserveParams, a as EdgeObserver, S as SessionCheckpoint, i as isEdgeObserver } from '../types-BJUMp1Dw.js';

/** Minimal subset of `redis` / `ioredis` — pass your own client instance. */
interface RedisLike {
    hSet(key: string, field: string, value: string): Promise<number | string | unknown>;
    hDel(key: string, ...fields: string[]): Promise<number | string | unknown>;
    hGetAll(key: string): Promise<Record<string, string>>;
}
declare function redis(client: RedisLike, options?: {
    key?: string;
}): DurabilityBackend;

export { DurabilityBackend, type RedisLike, redis };
