export interface SessionCheckpoint {
  sessionId: string;
  provider: string;
  lastEventId: string;
  createdAt: number;
  runId: string;
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

import type { AgentSessionConfig, Message, ToolResult } from "../types";

/** Subset of RequestParams safe to serialize (no AbortSignal, no functions). */
export interface SerializedRequestParams {
  messages: Message[];
  sessionId?: string;
  toolResults?: ToolResult[];
  vaultIds?: string[];
  providerOptions?: Record<string, unknown>;
  webhookMetadata?: Record<string, string>;
  agent?: AgentSessionConfig;
}

export interface EdgeEnqueueParams {
  sessionId: string;
  /** Unique identifier for this `send()` invocation. Forwarded in every webhook event. */
  runId: string;
  /** Stable turn identifier — groups multiple send() calls within one user interaction. */
  turnId: string;
  provider: string;
  /** Original request params — stored by the DO, returned in queue-ready webhook. */
  request: SerializedRequestParams;
  webhook: {
    url: string;
    secret: string;
    metadata?: Record<string, string>;
  };
}

export interface EdgeObserveParams {
  sessionId: string;
  runId: string;
  turnId: string;
  streamUrl: string;
  headers: Record<string, string>;
  provider: string;
  webhook: {
    url: string;
    secret: string;
    metadata?: Record<string, string>;
  };
}

/**
 * Edge-proxy durability — SSE lives outside the consumer process, events
 * delivered via webhook. The observer queues messages per session and
 * dispatches them one at a time.
 */
export interface EdgeObserver {
  /** Reserve a queue slot. Returns "active" if the session is idle (caller should dispatch + observe). */
  enqueue(params: EdgeEnqueueParams): Promise<{ status: "active" | "queued" }>;
  /** Start observing an SSE stream (called after SDK dispatch). */
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
  return (
    "enqueue" in backend &&
    "observe" in backend &&
    "stop" in backend &&
    !("save" in backend)
  );
}
