export { C as CloudflareBackendOptions, a as CloudflareEdgeObserver, W as WebhookConfig, c as cloudflare } from '../cloudflare-C1Hfnja7.cjs';
import { b as DurabilityBackend } from '../types-BJUMp1Dw.cjs';
export { D as DurableBackend, E as EdgeObserveParams, a as EdgeObserver, S as SessionCheckpoint, i as isEdgeObserver } from '../types-BJUMp1Dw.cjs';

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
