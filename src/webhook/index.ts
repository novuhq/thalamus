import { CALLBACK_MAP } from "../send-result";
import type {
  SessionEventsFactory,
  StreamCallbacks,
  StreamPart,
} from "../types";

export interface WebhookHandlerOptions {
  secret: string;
  /** Signature timestamp tolerance in seconds (default: 300). */
  tolerance?: number;
  onSessionEvents: SessionEventsFactory;
}

export interface WebhookHandlerResult {
  status: number;
  body: string | null;
}

export interface WebhookHandler {
  /** Web standard Request/Response (Cloudflare Workers, Bun, Deno, Next.js). */
  handle(req: Request): Promise<Response>;
  /** Node.js raw http adapter (Express, Koa, plain http). */
  express(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void>;
  /** Framework-agnostic: pass raw body + signature, get back status + body. */
  handleRaw(
    rawBody: string,
    signatureHeader: string | null,
  ): Promise<WebhookHandlerResult>;
}

interface WebhookPayload {
  sessionId: string;
  /** Unique identifier for the originating `send()` invocation. */
  runId: string;
  /** Stable turn identifier — groups multiple send() calls within one user interaction. */
  turnId?: string;
  sequence: number;
  timestamp: number;
  provider: string;
  metadata: Record<string, string>;
  event: StreamPart;
}

export function createWebhookHandler(
  options: WebhookHandlerOptions,
): WebhookHandler {
  const { secret, tolerance = 300, onSessionEvents } = options;

  async function verifySignature(
    rawBody: string,
    signatureHeader: string,
  ): Promise<boolean> {
    const parts = signatureHeader.split(",");
    const tPart = parts.find((p) => p.startsWith("t="));
    const v1Part = parts.find((p) => p.startsWith("v1="));
    if (!tPart || !v1Part) return false;

    const timestamp = Number(tPart.slice(2));
    const signature = v1Part.slice(3);

    if (Number.isNaN(timestamp)) return false;

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > tolerance) return false;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const payload = `${timestamp}.${rawBody}`;
    const expected = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(payload),
    );
    const expectedHex = Array.from(new Uint8Array(expected))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return timingSafeEqual(signature, expectedHex);
  }

  async function dispatch(
    callbacks: StreamCallbacks,
    event: StreamPart,
  ): Promise<void> {
    await callbacks.onPart?.(event);
    const key = CALLBACK_MAP[event.type];
    const cb = callbacks[key] as
      | ((part: unknown) => void | Promise<void>)
      | undefined;
    if (cb) await cb(event);
  }

  async function processRequest(
    rawBody: string,
    signatureHeader: string | null,
  ): Promise<WebhookHandlerResult> {
    if (!signatureHeader) {
      return {
        status: 401,
        body: JSON.stringify({ error: "Missing X-Thalamus-Signature header" }),
      };
    }

    const valid = await verifySignature(rawBody, signatureHeader);
    if (!valid) {
      return {
        status: 401,
        body: JSON.stringify({ error: "Invalid signature" }),
      };
    }

    let payload: WebhookPayload;
    try {
      payload = JSON.parse(rawBody) as WebhookPayload;
    } catch {
      return {
        status: 400,
        body: JSON.stringify({ error: "Malformed JSON body" }),
      };
    }

    const { sessionId, runId, turnId, metadata, event } = payload;

    if (!sessionId || !runId || !event?.type) {
      return {
        status: 400,
        body: JSON.stringify({
          error: "Missing sessionId, runId, or event",
        }),
      };
    }

    const callbacks = onSessionEvents({
      sessionId,
      turnId: turnId ?? crypto.randomUUID(),
      runId,
      metadata: metadata ?? {},
    });

    try {
      await dispatch(callbacks, event);
    } catch {
      return { status: 500, body: JSON.stringify({ error: "Callback error" }) };
    }

    return { status: 200, body: null };
  }

  return {
    async handleRaw(rawBody, signatureHeader) {
      return processRequest(rawBody, signatureHeader);
    },

    async handle(req: Request): Promise<Response> {
      if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers: { "Content-Type": "application/json" },
        });
      }

      const rawBody = await req.text();
      const signatureHeader = req.headers.get("X-Thalamus-Signature");
      const result = await processRequest(rawBody, signatureHeader);
      return new Response(result.body, {
        status: result.status,
        headers: result.body ? { "Content-Type": "application/json" } : {},
      });
    },

    async express(req, res): Promise<void> {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }

      const rawBody = await readNodeBody(req);
      const signatureHeader =
        (req.headers["x-thalamus-signature"] as string) ?? null;
      const result = await processRequest(rawBody, signatureHeader);
      res.writeHead(
        result.status,
        result.body ? { "Content-Type": "application/json" } : {},
      );
      res.end(result.body);
    },
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;

  let result = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}

function readNodeBody(
  req: import("node:http").IncomingMessage,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
