export interface SessionCheckpoint {
  sessionId: string;
  provider: string;
  lastEventId: string;
  createdAt: number;
  /**
   * The runId of the original `send()` invocation. Optional for backward
   * compatibility with checkpoints written before runId was introduced;
   * recovered sessions without one get a fresh runId.
   */
  runId?: string;
  metadata?: Record<string, string>;
}

/** Checkpoint-based durability — stores event cursors in an external store. */
export interface DurabilityBackend {
  save(checkpoint: SessionCheckpoint): Promise<void>;
  remove(sessionId: string): Promise<void>;
  getActive(): Promise<SessionCheckpoint[]>;
}

/* ------------------------------------------------------------------ */
/*  Edge observer — holds SSE connections at the edge on behalf of     */
/*  the application (e.g. Cloudflare Durable Objects).                 */
/* ------------------------------------------------------------------ */

export interface EdgeObserveParams {
  sessionId: string;
  /** Unique identifier for this `send()` invocation. Forwarded in every webhook event. */
  runId: string;
  streamUrl: string;
  headers: Record<string, string>;
  provider: string;
  webhook: {
    url: string;
    secret: string;
    metadata?: Record<string, string>;
  };
}

/** Edge-proxy durability — SSE lives outside the consumer process, events delivered via webhook. */
export interface EdgeObserver {
  observe(params: EdgeObserveParams): Promise<void>;
  stop(sessionId: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Unified type                                                       */
/* ------------------------------------------------------------------ */

export type DurableBackend = DurabilityBackend | EdgeObserver;

export function isEdgeObserver(
  backend: DurableBackend,
): backend is EdgeObserver {
  return "observe" in backend && "stop" in backend && !("save" in backend);
}
