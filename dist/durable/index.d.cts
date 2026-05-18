export { C as CloudflareBackendOptions, c as cloudflare } from '../cloudflare-CJwNwFRJ.cjs';
import { b as DurabilityBackend } from '../types-D5De32xL.cjs';
export { D as DurableBackend, E as EdgeObserveParams, a as EdgeObserver, S as SSEFrame, c as SessionCheckpoint, i as isEdgeObserver } from '../types-D5De32xL.cjs';

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
