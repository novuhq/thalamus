export interface SessionMutexOptions {
  maxQueueSize?: number;
}

interface SessionEntry {
  release: () => void;
  queue: Array<() => void>;
}

/**
 * Per-session mutex with FIFO ordering.
 *
 * Only one acquire() caller runs at a time per sessionId.
 * Subsequent callers wait in a queue and are admitted in order.
 */
export class SessionMutex {
  private sessions = new Map<string, SessionEntry>();
  private readonly maxQueueSize: number;

  constructor(options?: SessionMutexOptions) {
    this.maxQueueSize = options?.maxQueueSize ?? 50;
  }

  async acquire(sessionId: string, signal?: AbortSignal): Promise<() => void> {
    const session = this.sessions.get(sessionId);

    if (session) {
      await this.waitInQueue(session, signal);
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.admitNext(sessionId);
    };

    if (session) {
      session.release = release;
    } else {
      this.sessions.set(sessionId, { release, queue: [] });
    }

    return release;
  }

  /** Force-release the current holder by sessionId (e.g. after toolResults). */
  release(sessionId: string): void {
    this.sessions.get(sessionId)?.release();
  }

  private admitNext(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const next = session.queue.shift();
    if (next) {
      next();
    } else {
      this.sessions.delete(sessionId);
    }
  }

  private waitInQueue(
    session: SessionEntry,
    signal?: AbortSignal,
  ): Promise<void> {
    if (session.queue.length >= this.maxQueueSize) {
      throw new Error(
        `Session message queue is full (limit: ${this.maxQueueSize})`,
      );
    }

    return new Promise<void>((resolve, reject) => {
      session.queue.push(resolve);

      if (!signal) return;

      const onAbort = () => {
        const i = session.queue.indexOf(resolve);
        if (i !== -1) session.queue.splice(i, 1);
        reject(new Error("aborted"));
      };

      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
