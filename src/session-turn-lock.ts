export interface SessionTurnLockOptions {
  maxQueueSize?: number;
}

const DEFAULT_MAX_QUEUE_SIZE = 50;

export class SessionTurnLock {
  private chains = new Map<string, Promise<void>>();
  private waiters = new Map<string, number>();
  private activeReleases = new Map<string, () => void>();
  private readonly maxQueueSize: number;

  constructor(options?: SessionTurnLockOptions) {
    this.maxQueueSize = options?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
  }

  async acquire(sessionId: string, signal?: AbortSignal): Promise<() => void> {
    const prev = this.chains.get(sessionId);

    if (prev) {
      const waiters = this.waiters.get(sessionId) ?? 0;
      if (waiters >= this.maxQueueSize) {
        throw new Error(
          `Session message queue is full (limit: ${this.maxQueueSize})`,
        );
      }
      this.waiters.set(sessionId, waiters + 1);
    }

    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = () => {
        this.chains.delete(sessionId);
        this.waiters.delete(sessionId);
        this.activeReleases.delete(sessionId);
        r();
      };
    });
    this.chains.set(sessionId, next);

    if (prev) {
      if (signal) {
        await Promise.race([
          prev,
          new Promise<never>((_, reject) => {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          }),
        ]).catch((err) => {
          const w = (this.waiters.get(sessionId) ?? 1) - 1;
          if (w <= 0) this.waiters.delete(sessionId);
          else this.waiters.set(sessionId, w);
          release();
          throw err;
        });
      } else {
        await prev;
      }
      const w = (this.waiters.get(sessionId) ?? 1) - 1;
      if (w <= 0) this.waiters.delete(sessionId);
      else this.waiters.set(sessionId, w);
    }

    this.activeReleases.set(sessionId, release);
    return release;
  }

  /** Force-release the current holder (e.g. after toolResults completes the turn). */
  release(sessionId: string): void {
    this.activeReleases.get(sessionId)?.();
  }
}
