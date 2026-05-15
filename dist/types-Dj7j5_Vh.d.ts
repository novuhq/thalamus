interface SessionCheckpoint {
    sessionId: string;
    provider: string;
    lastEventId: string;
    createdAt: number;
    metadata?: Record<string, string>;
}
interface DurabilityBackend {
    save(checkpoint: SessionCheckpoint): Promise<void>;
    remove(sessionId: string): Promise<void>;
    getActive(): Promise<SessionCheckpoint[]>;
}
interface SSEFrame {
    event?: string;
    id?: string;
    data?: string;
}
interface EdgeObserveParams {
    sessionId: string;
    streamUrl: string;
    headers: Record<string, string>;
}
/** Backends that implement this can open SSE connections at the edge. */
interface EdgeObserver {
    observe(params: EdgeObserveParams): Promise<void>;
    stop(sessionId: string): Promise<void>;
    events(sessionId: string): AsyncIterable<SSEFrame>;
}

export type { DurabilityBackend as D, EdgeObserver as E, SSEFrame as S, EdgeObserveParams as a, SessionCheckpoint as b };
