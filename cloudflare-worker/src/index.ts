import type {
  StreamPart,
  Response as ThalamusResponse,
  Usage,
} from "@novu/thalamus";
import { mapAnthropicEvent } from "@novu/thalamus/anthropic";
import { mapOpenAIEvent } from "@novu/thalamus/openai";
import {
  Agent,
  type Connection,
  type ConnectionContext,
  type FiberRecoveryContext,
} from "agents";
import {
  type EventSourceMessage,
  EventSourceParserStream,
} from "eventsource-parser/stream";

/* ------------------------------------------------------------------ */
/*  Provider registry                                                   */
/* ------------------------------------------------------------------ */

/**
 * Lightweight accumulator for edge observation.
 * Inherits the shape parsers expect but discards content/tool-call data
 * since those are delivered as individual parts. Only metadata needed for
 * the `finish` event is retained — keeps memory bounded for long sessions.
 */
class EdgeAccumulator {
  done = false;
  finishReason: ThalamusResponse["finishReason"] = "stop";
  usage: Usage | undefined;
  actionsRequired: never[] = [];
  sessionId: string | undefined;
  conversationId: string | undefined;

  set content(_: string) {}
  get content() {
    return "";
  }

  toResponse(sessionId?: string): ThalamusResponse {
    return {
      content: "",
      sessionId: sessionId ?? this.conversationId ?? this.sessionId,
      finishReason: this.finishReason,
      usage: this.usage,
    };
  }
}

interface ProviderParser {
  createAccumulator(): EdgeAccumulator;
  mapEvent(raw: unknown, acc: EdgeAccumulator): Generator<StreamPart>;
}

const providers: Record<string, ProviderParser> = {
  anthropic: {
    createAccumulator: () => new EdgeAccumulator(),
    mapEvent: (raw, acc) => mapAnthropicEvent(raw as any, acc as any),
  },
  openai: {
    createAccumulator: () => new EdgeAccumulator(),
    mapEvent: (raw, acc) => mapOpenAIEvent(raw as any, acc as any),
  },
};

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface Env {
  SESSION_OBSERVER: DurableObjectNamespace<SessionObserver>;
  API_KEY?: string;
}

export interface ObservationParams {
  sessionId: string;
  streamUrl: string;
  headers: Record<string, string>;
  lastEventId?: string;
  provider: string;
  webhook: {
    url: string;
    secret: string;
    metadata?: Record<string, string>;
  };
}

type EventRow = {
  id: number;
  session_id: string;
  sequence: number;
  event_json: string;
  status: string;
  attempts: number;
  created_at: number;
  [key: string]: SqlStorageValue;
};

type DeliveryOutcome = "delivered" | "skipped" | "exhausted";

type ObservationStatus = "active" | "completed" | "error";

type State = {
  observation: (ObservationParams & { status: ObservationStatus }) | null;
};

/* ------------------------------------------------------------------ */
/*  SessionObserver — one Durable Object per session                   */
/*                                                                     */
/*  Opens an SSE connection to a provider API, normalizes events into  */
/*  StreamParts, persists to SQLite, and delivers via HTTP POST with   */
/*  HMAC signatures and exponential backoff retries.                   */
/* ------------------------------------------------------------------ */

const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];
const MAX_ATTEMPTS = 10;

export class SessionObserver extends Agent<Env, State> {
  initialState: State = { observation: null };

  private abortController: AbortController | null = null;
  private delivering = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          event_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        )
      `);
    });
  }

  /* ---------- RPC: observation control ---------- */

  async startObserving(params: ObservationParams): Promise<void> {
    this.abortController?.abort();

    this.updateObservation({ ...params, status: "active" });

    const controller = new AbortController();
    this.abortController = controller;

    void this.runFiber("observe", async (ctx) => {
      ctx.stash(params);
      await this.observeSSE(params, ctx, controller.signal);
    });
  }

  async stopObserving(): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;
    const sessionId = this.state.observation?.sessionId;
    this.setState({ observation: null });
    this.cleanupEvents(sessionId);
  }

  async getStatus(): Promise<string> {
    return this.state.observation?.status ?? "none";
  }

  /* ---------- Reject WebSocket upgrades ---------- */

  async onConnect(
    connection: Connection,
    _ctx: ConnectionContext,
  ): Promise<void> {
    connection.close(4000, "WebSocket not supported — use webhook delivery");
  }

  /* ---------- Fiber recovery ---------- */

  async onFiberRecovered(ctx: FiberRecoveryContext): Promise<void> {
    if (ctx.name !== "observe") return;
    const snapshot = ctx.snapshot as ObservationParams | null;
    if (!snapshot || !this.state.observation) return;
    void this.startObserving(snapshot);
  }

  /* ---------- Internal: SSE observation + event processing ---------- */

  private async observeSSE(
    params: ObservationParams,
    fiberCtx: { stash(data: unknown): void },
    signal: AbortSignal,
  ): Promise<void> {
    const parser = providers[params.provider];
    if (!parser) {
      throw new Error(`Unsupported provider: ${params.provider}`);
    }

    const fetchHeaders: Record<string, string> = {
      ...params.headers,
      Accept: "text/event-stream",
    };
    if (params.lastEventId) {
      fetchHeaders["Last-Event-ID"] = params.lastEventId;
    }

    const response = await fetch(params.streamUrl, {
      headers: fetchHeaders,
      redirect: "manual",
      signal,
    });

    if (!response.ok || !response.body) {
      this.updateObservation({
        ...(this.state.observation ?? params),
        status: "error",
      });
      throw new Error(`SSE connection failed: ${response.status}`);
    }

    const eventStream = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream());

    const acc = parser.createAccumulator();
    let sequence = this.getNextSequence(params.sessionId);

    for await (const sseEvent of eventStream) {
      if (signal.aborted) break;

      if (sseEvent.id) {
        fiberCtx.stash({ ...params, lastEventId: sseEvent.id });
      }

      const parts = this.parseSSEEvent(sseEvent, parser, acc);
      for (const part of parts) {
        this.persistEvent(params.sessionId, sequence++, part);
      }

      this.triggerDelivery(params);

      if (acc.done) break;
    }

    if (acc.done || !signal.aborted) {
      const finish: StreamPart = {
        type: "finish",
        response: acc.toResponse(params.sessionId),
      };
      this.persistEvent(params.sessionId, sequence++, finish);
      this.triggerDelivery(params);
      this.updateObservation({
        ...this.state.observation!,
        status: "completed",
      });
    }
  }

  private parseSSEEvent(
    sseEvent: EventSourceMessage,
    parser: ProviderParser,
    acc: EdgeAccumulator,
  ): StreamPart[] {
    if (!sseEvent.data) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(sseEvent.data);
    } catch {
      return [];
    }

    const parts: StreamPart[] = [];
    try {
      for (const part of parser.mapEvent(parsed, acc)) {
        parts.push(part);
      }
    } catch (err) {
      parts.push({
        type: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
    return parts;
  }

  /* ---------- SQLite event queue ---------- */

  private persistEvent(
    sessionId: string,
    sequence: number,
    event: StreamPart,
  ): void {
    const serializable =
      event.type === "error"
        ? {
            type: "error",
            error: { message: event.error.message, name: event.error.name },
          }
        : event;
    this.ctx.storage.sql.exec(
      "INSERT INTO events (session_id, sequence, event_json, status, attempts, created_at) VALUES (?, ?, ?, 'pending', 0, ?)",
      sessionId,
      sequence,
      JSON.stringify(serializable),
      Math.floor(Date.now() / 1000),
    );
  }

  private getNextSequence(sessionId: string): number {
    const row = this.ctx.storage.sql
      .exec<{ max_seq: number | null }>(
        "SELECT MAX(sequence) as max_seq FROM events WHERE session_id = ?",
        sessionId,
      )
      .toArray()[0];
    return (row?.max_seq ?? 0) + 1;
  }

  private getPendingEvents(sessionId: string): EventRow[] {
    return this.ctx.storage.sql
      .exec<EventRow>(
        "SELECT * FROM events WHERE session_id = ? AND status = 'pending' ORDER BY sequence ASC",
        sessionId,
      )
      .toArray();
  }

  private markFailed(id: number): void {
    this.ctx.storage.sql.exec(
      "UPDATE events SET status = 'failed' WHERE id = ?",
      id,
    );
  }

  private markDead(id: number): void {
    this.ctx.storage.sql.exec(
      "UPDATE events SET status = 'dead' WHERE id = ?",
      id,
    );
  }

  private deleteEvent(id: number): void {
    this.ctx.storage.sql.exec("DELETE FROM events WHERE id = ?", id);
  }

  private incrementAttempts(id: number): void {
    this.ctx.storage.sql.exec(
      "UPDATE events SET attempts = attempts + 1 WHERE id = ?",
      id,
    );
  }

  private cleanupEvents(sessionId?: string): void {
    if (!sessionId) return;
    this.ctx.storage.sql.exec(
      "DELETE FROM events WHERE session_id = ?",
      sessionId,
    );
  }

  /* ---------- Webhook delivery ---------- */

  private triggerDelivery(params: ObservationParams): void {
    if (this.delivering) return;
    this.delivering = true;
    void this.deliverPending(params).finally(() => {
      this.delivering = false;
    });
  }

  private async deliverPending(params: ObservationParams): Promise<void> {
    const { sessionId } = params;

    while (true) {
      const pending = this.getPendingEvents(sessionId);
      if (pending.length === 0) break;

      const row = pending[0];
      const event = JSON.parse(row.event_json) as StreamPart;
      const outcome = await this.deliverWithRetry(row, event, params);

      switch (outcome) {
        case "delivered":
        case "skipped":
          this.deleteEvent(row.id);
          if (
            (event.type === "finish" || event.type === "error") &&
            outcome === "delivered"
          ) {
            this.cleanupEvents(sessionId);
            return;
          }
          break;

        case "exhausted":
          this.markDead(row.id);
          console.error(
            `Event delivery exhausted: session=${sessionId} seq=${row.sequence} type=${event.type}`,
          );
          break;
      }
    }
  }

  private async deliverWithRetry(
    row: EventRow,
    event: StreamPart,
    params: ObservationParams,
  ): Promise<DeliveryOutcome> {
    const { sessionId, provider, webhook } = params;

    const body = JSON.stringify({
      sessionId,
      sequence: row.sequence,
      timestamp: row.created_at,
      provider,
      metadata: webhook.metadata ?? {},
      event,
    });

    for (let attempt = row.attempts; attempt < MAX_ATTEMPTS; attempt++) {
      this.incrementAttempts(row.id);

      const signature = await this.sign(body, webhook.secret, row.created_at);

      try {
        const res = await fetch(webhook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Thalamus-Signature": signature,
            "X-Thalamus-Event-Type": event.type,
            "X-Thalamus-Session-Id": sessionId,
            "X-Thalamus-Sequence": String(row.sequence),
          },
          body,
        });

        if (res.status >= 200 && res.status < 300) {
          return "delivered";
        }

        if (res.status >= 400 && res.status < 500) {
          console.warn(
            `Webhook 4xx (permanent failure): session=${sessionId} seq=${row.sequence} status=${res.status}`,
          );
          this.markFailed(row.id);
          return "skipped";
        }
      } catch (err) {
        console.warn(
          `Webhook network error: session=${sessionId} seq=${row.sequence} attempt=${attempt + 1}`,
          err,
        );
      }

      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
        await sleep(delay);
      }
    }

    return "exhausted";
  }

  /* ---------- HMAC signature ---------- */

  private async sign(
    body: string,
    secret: string,
    timestamp: number,
  ): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const payload = `${timestamp}.${body}`;
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    const hex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `t=${timestamp},v1=${hex}`;
  }

  /* ---------- Helpers ---------- */

  private updateObservation(
    obs: (ObservationParams & { status: ObservationStatus }) | null,
  ): void {
    this.setState({ observation: obs });
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const encoder = new TextEncoder();
const subtle = crypto.subtle as unknown as {
  timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean;
};

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return subtle.timingSafeEqual(bufA, bufB);
}

function validateObservationParams(body: unknown): body is ObservationParams {
  if (typeof body !== "object" || body === null) return false;
  const obj = body as Record<string, unknown>;
  if (typeof obj.sessionId !== "string" || obj.sessionId.length === 0)
    return false;
  if (typeof obj.streamUrl !== "string") return false;
  try {
    new URL(obj.streamUrl);
  } catch {
    return false;
  }
  if (
    typeof obj.headers !== "object" ||
    obj.headers === null ||
    Array.isArray(obj.headers)
  )
    return false;
  const headers = obj.headers as Record<string, unknown>;
  for (const val of Object.values(headers)) {
    if (typeof val !== "string") return false;
  }
  if (typeof obj.provider !== "string" || !providers[obj.provider])
    return false;
  if (typeof obj.webhook !== "object" || obj.webhook === null) return false;
  const webhook = obj.webhook as Record<string, unknown>;
  if (typeof webhook.url !== "string") return false;
  try {
    new URL(webhook.url);
  } catch {
    return false;
  }
  if (typeof webhook.secret !== "string" || webhook.secret.length === 0)
    return false;

  return true;
}

/* ------------------------------------------------------------------ */
/*  Worker entry                                                       */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") {
      return Response.json({ status: "ok" });
    }

    if (request.headers.get("Upgrade") === "websocket") {
      return new Response("WebSocket not supported — use webhook delivery", {
        status: 400,
      });
    }

    if (env.API_KEY) {
      const auth = request.headers.get("Authorization") ?? "";
      if (!timingSafeEqual(auth, `Bearer ${env.API_KEY}`)) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    try {
      if (request.method === "POST" && path === "/observe") {
        const body = await request.json();
        if (!validateObservationParams(body)) {
          return Response.json(
            {
              error:
                "Invalid params: sessionId, streamUrl, headers, provider, and webhook are required",
            },
            { status: 400 },
          );
        }
        const stub = env.SESSION_OBSERVER.getByName(body.sessionId);
        await stub.startObserving(body);
        return new Response(null, { status: 204 });
      }

      if (request.method === "DELETE" && path.startsWith("/observe/")) {
        const sessionId = decodeURIComponent(path.slice("/observe/".length));
        const stub = env.SESSION_OBSERVER.getByName(sessionId);
        await stub.stopObserving();
        return new Response(null, { status: 204 });
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("Worker request failed:", err);
      return new Response("Internal server error", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
