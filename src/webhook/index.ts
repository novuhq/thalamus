import type { StreamCallbacks, StreamPart } from "../types";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type SessionEventsFactory = (
  sessionId: string,
  metadata: Record<string, string>,
) => StreamCallbacks;

export interface WebhookHandlerOptions {
  secret: string;
  /** Signature timestamp tolerance in seconds (default: 300). */
  tolerance?: number;
  onSessionEvents: SessionEventsFactory;
}

export interface WebhookHandler {
  handle(req: Request): Promise<Response>;
  express(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void>;
}

interface WebhookPayload {
  sessionId: string;
  sequence: number;
  timestamp: number;
  provider: string;
  metadata: Record<string, string>;
  event: StreamPart;
}

/* ------------------------------------------------------------------ */
/*  Callback map (mirrors send-result.ts)                              */
/* ------------------------------------------------------------------ */

const CALLBACK_MAP: Record<StreamPart["type"], keyof StreamCallbacks> = {
  "text-delta": "onTextDelta",
  thinking: "onThinking",
  refusal: "onRefusal",
  "tool-use-start": "onToolUseStart",
  "tool-use-delta": "onToolUseDelta",
  "tool-use-done": "onToolUseDone",
  "tool-use-result": "onToolUseResult",
  "mcp-tools-discovered": "onMcpToolsDiscovered",
  "status-change": "onStatusChange",
  "stream-start": "onStreamStart",
  finish: "onFinish",
  error: "onError",
  "provider-event": "onProviderEvent",
};

/* ------------------------------------------------------------------ */
/*  createWebhookHandler                                               */
/* ------------------------------------------------------------------ */

export function createWebhookHandler(
  options: WebhookHandlerOptions,
): WebhookHandler {
  const { secret, tolerance = 300, onSessionEvents } = options;
  const sessionCache = new Map<string, StreamCallbacks>();

  function getCallbacks(
    sessionId: string,
    metadata: Record<string, string>,
  ): StreamCallbacks {
    let callbacks = sessionCache.get(sessionId);
    if (!callbacks) {
      callbacks = onSessionEvents(sessionId, metadata);
      sessionCache.set(sessionId, callbacks);
    }
    return callbacks;
  }

  function evictSession(sessionId: string): void {
    sessionCache.delete(sessionId);
  }

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

  function dispatch(callbacks: StreamCallbacks, event: StreamPart): void {
    callbacks.onPart?.(event);
    const key = CALLBACK_MAP[event.type];
    const cb = callbacks[key] as ((part: unknown) => void) | undefined;
    if (cb) cb(event);
  }

  async function processRequest(
    rawBody: string,
    signatureHeader: string | null,
  ): Promise<Response> {
    if (!signatureHeader) {
      return new Response(
        JSON.stringify({ error: "Missing X-Thalamus-Signature header" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    const valid = await verifySignature(rawBody, signatureHeader);
    if (!valid) {
      return new Response(JSON.stringify({ error: "Invalid signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    let payload: WebhookPayload;
    try {
      payload = JSON.parse(rawBody) as WebhookPayload;
    } catch {
      return new Response(JSON.stringify({ error: "Malformed JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { sessionId, metadata, event } = payload;

    if (!sessionId || !event?.type) {
      return new Response(
        JSON.stringify({ error: "Missing sessionId or event" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const callbacks = getCallbacks(sessionId, metadata ?? {});

    try {
      dispatch(callbacks, event);
    } catch (err) {
      return new Response(JSON.stringify({ error: "Callback error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (event.type === "finish" || event.type === "error") {
      evictSession(sessionId);
    }

    return new Response(null, { status: 200 });
  }

  return {
    async handle(req: Request): Promise<Response> {
      if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers: { "Content-Type": "application/json" },
        });
      }

      const rawBody = await req.text();
      const signatureHeader = req.headers.get("X-Thalamus-Signature");
      return processRequest(rawBody, signatureHeader);
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
      const response = await processRequest(rawBody, signatureHeader);

      res.writeHead(response.status, {
        "Content-Type":
          response.headers.get("Content-Type") ?? "application/json",
      });
      res.end(await response.text());
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

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
