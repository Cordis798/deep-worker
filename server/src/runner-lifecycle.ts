let pauseCount = 0;
let pauseReason: string | null = null;
let resumeWaiters: Array<() => void> = [];

export const runnerLifecycle = {
  pause(reason: string): void {
    pauseCount += 1;
    pauseReason = reason;
  },
  resume(): void {
    pauseCount = Math.max(0, pauseCount - 1);
    if (pauseCount === 0) {
      pauseReason = null;
      const waiters = resumeWaiters;
      resumeWaiters = [];
      for (const resolve of waiters) resolve();
    }
  },
  isPaused(): boolean { return pauseCount > 0; },
  reason(): string | null { return pauseReason; },
  waitUntilResumed(): Promise<void> {
    if (pauseCount === 0) return Promise.resolve();
    return new Promise((resolve) => resumeWaiters.push(resolve));
  },
};
