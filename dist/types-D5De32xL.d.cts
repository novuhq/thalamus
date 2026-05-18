interface SessionCheckpoint {
    sessionId: string;
    provider: string;
    lastEventId: string;
    createdAt: number;
    metadata?: Record<string, string>;
}
/** Checkpoint-based durability — stores event cursors in an external store. */
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
/** Edge-proxy durability — SSE lives outside the consumer process. */
interface EdgeObserver {
    observe(params: EdgeObserveParams): Promise<void>;
    stop(sessionId: string): Promise<void>;
    events(sessionId: string): AsyncIterable<SSEFrame>;
    listActive(): Promise<string[]>;
}
type DurableBackend = DurabilityBackend | EdgeObserver;
declare function isEdgeObserver(backend: DurableBackend): backend is EdgeObserver;

export { type DurableBackend as D, type EdgeObserveParams as E, type SSEFrame as S, type EdgeObserver as a, type DurabilityBackend as b, type SessionCheckpoint as c, isEdgeObserver as i };
