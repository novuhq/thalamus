import type { StreamPart } from "@novu/thalamus";
import {
  AnthropicResponseAccumulator as AnthropicAccumulator,
  mapAnthropicEvent,
} from "@novu/thalamus/anthropic";
import {
  mapOpenAIEvent,
  OpenAIResponseAccumulator as OpenAIAccumulator,
} from "@novu/thalamus/openai";
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
  provider: "anthropic" | "openai";
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
      if (this.state.observation) {
        this.updateObservation({ ...this.state.observation, status: "error" });
      }
      throw new Error(`SSE connection failed: ${response.status}`);
    }

    const eventStream = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream());

    const accumulator = this.createAccumulator(params.provider);
    let sequence = this.getNextSequence(params.sessionId);

    for await (const sseEvent of eventStream) {
      if (signal.aborted) break;

      if (sseEvent.id) {
        fiberCtx.stash({ ...params, lastEventId: sseEvent.id });
      }

      const streamParts = this.parseSSEEvent(
        sseEvent,
        params.provider,
        accumulator,
      );
      for (const part of streamParts) {
        this.persistEvent(params.sessionId, sequence++, part);
      }

      this.triggerDelivery(params);
    }

    if (!signal.aborted) {
      const finishEvent = this.buildFinishEvent(params, accumulator);
      this.persistEvent(params.sessionId, sequence++, finishEvent);
      this.triggerDelivery(params);
      this.updateObservation({
        ...this.state.observation!,
        status: "completed",
      });
    }
  }

  private parseSSEEvent(
    sseEvent: EventSourceMessage,
    provider: "anthropic" | "openai",
    accumulator: AnthropicAccumulator | OpenAIAccumulator,
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
      if (provider === "anthropic") {
        for (const part of mapAnthropicEvent(
          parsed as any,
          accumulator as AnthropicAccumulator,
        )) {
          parts.push(part);
        }
      } else {
        for (const part of mapOpenAIEvent(
          parsed as any,
          accumulator as OpenAIAccumulator,
        )) {
          parts.push(part);
        }
      }
    } catch (err) {
      parts.push({
        type: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
    return parts;
  }

  private buildFinishEvent(
    params: ObservationParams,
    accumulator: AnthropicAccumulator | OpenAIAccumulator,
  ): StreamPart {
    if (accumulator instanceof AnthropicAccumulator) {
      return {
        type: "finish",
        response: accumulator.toResponse(params.sessionId),
      };
    }
    return {
      type: "finish",
      response: (accumulator as OpenAIAccumulator).toResponse(),
    };
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
    const { sessionId, webhook } = params;

    while (true) {
      const pending = this.getPendingEvents(sessionId);
      if (pending.length === 0) break;

      for (const row of pending) {
        const event = JSON.parse(row.event_json) as StreamPart;
        const delivered = await this.deliverWithRetry(row, event, params);

        if (delivered) {
          this.deleteEvent(row.id);
        } else {
          // Max retries exhausted or permanent failure
          break;
        }

        const isTerminal = event.type === "finish" || event.type === "error";
        if (isTerminal && delivered) {
          this.cleanupEvents(sessionId);
          return;
        }
      }

      // If we broke out of the for-loop (delivery failed), stop
      const stillPending = this.getPendingEvents(sessionId);
      if (stillPending.length > 0 && stillPending[0].attempts >= MAX_ATTEMPTS) {
        this.markDead(stillPending[0].id);
        // Skip dead event, continue with next
        continue;
      }
      if (stillPending.length > 0) break;
    }
  }

  private async deliverWithRetry(
    row: EventRow,
    event: StreamPart,
    params: ObservationParams,
  ): Promise<boolean> {
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
          return true;
        }

        if (res.status >= 400 && res.status < 500) {
          this.markFailed(row.id);
          return true; // Skip this event (permanent failure)
        }

        // 5xx — retry
      } catch {
        // Network error — retry
      }

      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
        await sleep(delay);
      }
    }

    return false; // Exhausted retries
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

  private createAccumulator(provider: "anthropic" | "openai") {
    return provider === "anthropic"
      ? new AnthropicAccumulator()
      : new OpenAIAccumulator();
  }

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
  if (obj.provider !== "anthropic" && obj.provider !== "openai") return false;
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
