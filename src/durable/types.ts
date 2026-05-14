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
