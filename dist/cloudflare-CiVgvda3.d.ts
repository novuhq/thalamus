import { a as EdgeObserver } from './types-BJUMp1Dw.js';

interface WebhookConfig {
    url: string;
    secret: string;
}
interface CloudflareBackendOptions {
    url: string;
    apiKey?: string;
    webhook: WebhookConfig;
}
interface CloudflareEdgeObserver extends EdgeObserver {
    readonly webhook: WebhookConfig;
}
declare function cloudflare(options: CloudflareBackendOptions): CloudflareEdgeObserver;

export { type CloudflareBackendOptions as C, type WebhookConfig as W, type CloudflareEdgeObserver as a, cloudflare as c };
