import { a as EdgeObserver } from './types-D5De32xL.cjs';

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

export { type CloudflareBackendOptions as C, cloudflare as c };
