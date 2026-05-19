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
interface EdgeObserveParams {
    sessionId: string;
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
interface EdgeObserver {
    observe(params: EdgeObserveParams): Promise<void>;
    stop(sessionId: string): Promise<void>;
}
type DurableBackend = DurabilityBackend | EdgeObserver;
declare function isEdgeObserver(backend: DurableBackend): backend is EdgeObserver;

export { type DurableBackend as D, type EdgeObserveParams as E, type SessionCheckpoint as S, type EdgeObserver as a, type DurabilityBackend as b, isEdgeObserver as i };
