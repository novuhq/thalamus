export interface SessionCheckpoint {
  sessionId: string;
  provider: string;
  lastEventId: string;
  createdAt: number;
  metadata?: Record<string, string>;
}

export interface DurabilityBackend {
  save(checkpoint: SessionCheckpoint): Promise<void>;
  remove(sessionId: string): Promise<void>;
  getActive(): Promise<SessionCheckpoint[]>;
}

/* ------------------------------------------------------------------ */
/*  Edge observer — optional extension for backends that can           */
/*  observe SSE streams on behalf of the application (e.g. Cloudflare) */
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

/** Backends that implement this can open SSE connections at the edge. */
export interface EdgeObserver {
  observe(params: EdgeObserveParams): Promise<void>;
  stop(sessionId: string): Promise<void>;
  events(sessionId: string): AsyncIterable<SSEFrame>;
}
