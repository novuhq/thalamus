import * as node_http from 'node:http';
import { a as StreamCallbacks } from '../types-D03ofbVu.js';
import '../vault.interface-BMCawAU1.js';

type SessionEventsFactory = (sessionId: string, metadata: Record<string, string>) => StreamCallbacks;
interface WebhookHandlerOptions {
    secret: string;
    /** Signature timestamp tolerance in seconds (default: 300). */
    tolerance?: number;
    onSessionEvents: SessionEventsFactory;
}
interface WebhookHandler {
    handle(req: Request): Promise<Response>;
    express(req: node_http.IncomingMessage, res: node_http.ServerResponse): Promise<void>;
}
declare function createWebhookHandler(options: WebhookHandlerOptions): WebhookHandler;

export { type SessionEventsFactory, type WebhookHandler, type WebhookHandlerOptions, createWebhookHandler };
