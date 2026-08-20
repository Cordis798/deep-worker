export interface SessionQueueOptions {
  maxPendingPerSession?: number;
  maxAttempts?: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
  retryDelay?: (delayMs: number) => Promise<void>;
}

export interface QueueResult<T> {
  value: T;
  attempts: number;
}

export class SessionQueueCapacityError extends Error {
  constructor(sessionId: string) {
    super(`Session queue capacity exceeded for ${sessionId}`);
    this.name = 'SessionQueueCapacityError';
  }
}

interface Job<T> {
  run: () => Promise<T>;
  resolve: (result: QueueResult<T>) => void;
  reject: (error: unknown) => void;
}

interface SessionState {
  running: boolean;
  pending: Job<unknown>[];
}

const sleep = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs));

/** 每个会话使用 FIFO 队列；不同会话可以并发消费。 */
export class SessionQueue {
  private readonly states = new Map<string, SessionState>();
  private readonly maxPendingPerSession: number;
  private readonly maxAttempts: number;
  private readonly baseRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly retryDelay: (delayMs: number) => Promise<void>;
  private closed = false;

  constructor(options: SessionQueueOptions = {}) {
    this.maxPendingPerSession = options.maxPendingPerSession ?? 100;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseRetryMs = options.baseRetryMs ?? 100;
    this.maxRetryMs = options.maxRetryMs ?? 5_000;
    this.retryDelay = options.retryDelay ?? sleep;
  }

  enqueue<T>(sessionId: string, run: () => Promise<T>): Promise<QueueResult<T>> {
    if (this.closed) return Promise.reject(new Error('Session queue is closed'));
    const state = this.states.get(sessionId) ?? { running: false, pending: [] };
    if (state.pending.length >= this.maxPendingPerSession) {
      return Promise.reject(new SessionQueueCapacityError(sessionId));
    }
    this.states.set(sessionId, state);
    const promise = new Promise<QueueResult<T>>((resolve, reject) => {
      state.pending.push({ run, resolve, reject } as Job<unknown>);
    });
    void this.drain(sessionId, state);
    return promise;
  }

  close(): void {
    this.closed = true;
    for (const state of this.states.values()) {
      for (const job of state.pending.splice(0))
        job.reject(new Error('Session queue is closed'));
    }
    this.states.clear();
  }

  pendingCount(sessionId?: string): number {
    if (sessionId) return this.states.get(sessionId)?.pending.length ?? 0;
    return [...this.states.values()].reduce((total, state) => total + state.pending.length, 0);
  }

  private async drain(sessionId: string, state: SessionState): Promise<void> {
    if (state.running) return;
    state.running = true;
    try {
      while (state.pending.length > 0) {
        const job = state.pending.shift()!;
        try {
          let attempts = 0;
          while (true) {
            attempts += 1;
            try {
              const value = await job.run();
              job.resolve({ value, attempts });
              break;
            } catch (error) {
              if (attempts >= this.maxAttempts) {
                job.reject(error);
                break;
              }
              const delayMs = Math.min(this.maxRetryMs, this.baseRetryMs * 2 ** (attempts - 1));
              await this.retryDelay(delayMs);
            }
          }
        } catch (error) {
          job.reject(error);
        }
      }
    } finally {
      state.running = false;
      if (state.pending.length === 0) this.states.delete(sessionId);
      else void this.drain(sessionId, state);
    }
  }
}
