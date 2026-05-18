export interface SessionCheckpoint {
  sessionId: string;
  provider: string;
  lastEventId: string;
  createdAt: number;
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

export interface SSEFrame {
  event?: string;
  id?: string;
  data?: string;
}

export interface EdgeObserveParams {
  sessionId: string;
  streamUrl: string;
  headers: Record<string, string>;
}

/** Edge-proxy durability — SSE lives outside the consumer process. */
export interface EdgeObserver {
  observe(params: EdgeObserveParams): Promise<void>;
  stop(sessionId: string): Promise<void>;
  events(sessionId: string): AsyncIterable<SSEFrame>;
  listActive(): Promise<string[]>;
}

/* ------------------------------------------------------------------ */
/*  Unified type                                                       */
/* ------------------------------------------------------------------ */

export type DurableBackend = DurabilityBackend | EdgeObserver;

export function isEdgeObserver(
  backend: DurableBackend,
): backend is EdgeObserver {
  return "observe" in backend && "events" in backend;
}
