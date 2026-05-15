import { E as EdgeObserver, D as DurabilityBackend } from '../types-Dj7j5_Vh.cjs';
export { a as EdgeObserveParams, S as SSEFrame, b as SessionCheckpoint } from '../types-Dj7j5_Vh.cjs';

interface CloudflareBackendOptions {
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
declare function cloudflare(options: CloudflareBackendOptions): EdgeObserver;

/** Minimal subset of `redis` / `ioredis` — pass your own client instance. */
interface RedisLike {
    hSet(key: string, field: string, value: string): Promise<number | string | unknown>;
    hDel(key: string, ...fields: string[]): Promise<number | string | unknown>;
    hGetAll(key: string): Promise<Record<string, string>>;
}
declare function redis(client: RedisLike, options?: {
    key?: string;
}): DurabilityBackend;

export { type CloudflareBackendOptions, DurabilityBackend, EdgeObserver, type RedisLike, cloudflare, redis };
