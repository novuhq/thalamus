import * as node_http from 'node:http';
import { a as StreamCallbacks } from '../types-D5jxkcf8.cjs';
import '../vault.interface-BMCawAU1.cjs';

type SessionEventsFactory = (sessionId: string, metadata: Record<string, string>) => StreamCallbacks;
interface WebhookHandlerOptions {
    secret: string;
    /** Signature timestamp tolerance in seconds (default: 300). */
    tolerance?: number;
    onSessionEvents: SessionEventsFactory;
}
interface WebhookHandlerResult {
    status: number;
    body: string | null;
}
interface WebhookHandler {
    /** Web standard Request/Response (Cloudflare Workers, Bun, Deno, Next.js). */
    handle(req: Request): Promise<Response>;
    /** Node.js raw http adapter (Express, Koa, plain http). */
    express(req: node_http.IncomingMessage, res: node_http.ServerResponse): Promise<void>;
    /** Framework-agnostic: pass raw body + signature, get back status + body. */
    handleRaw(rawBody: string, signatureHeader: string | null): Promise<WebhookHandlerResult>;
}
declare function createWebhookHandler(options: WebhookHandlerOptions): WebhookHandler;

export { type SessionEventsFactory, type WebhookHandler, type WebhookHandlerOptions, type WebhookHandlerResult, createWebhookHandler };
