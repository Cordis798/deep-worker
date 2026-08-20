import { describe, expect, it } from 'vitest';
import { SessionQueue } from './session-queue.js';

describe('SessionQueue', () => {
  it('serializes one session but runs different sessions concurrently', async () => {
    const queue = new SessionQueue({ retryDelay: async () => undefined });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = queue.enqueue('a', async () => {
      order.push('a1-start');
      await firstGate;
      order.push('a1-end');
      return 1;
    });
    const second = queue.enqueue('a', async () => {
      order.push('a2');
      return 2;
    });
    const other = queue.enqueue('b', async () => {
      order.push('b1');
      return 3;
    });
    await other;
    expect(order).toContain('b1');
    expect(order).not.toContain('a2');
    releaseFirst();
    await expect(first).resolves.toMatchObject({ value: 1, attempts: 1 });
    await expect(second).resolves.toMatchObject({ value: 2, attempts: 1 });
    expect(order.indexOf('a1-end')).toBeLessThan(order.indexOf('a2'));
  });

  it('retries failures with a bounded attempt count', async () => {
    let calls = 0;
    const queue = new SessionQueue({
      maxAttempts: 3,
      retryDelay: async () => undefined,
    });
    await expect(
      queue.enqueue('s', async () => {
        calls += 1;
        if (calls < 3) throw new Error('temporary');
        return 'ok';
      }),
    ).resolves.toMatchObject({ value: 'ok', attempts: 3 });
    expect(calls).toBe(3);
  });

  it('rejects when a session reaches capacity', async () => {
    const queue = new SessionQueue({ maxPendingPerSession: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.enqueue('s', async () => {
      await gate;
      return 1;
    });
    const second = queue.enqueue('s', async () => 2);
    await expect(queue.enqueue('s', async () => 3)).rejects.toThrow(/capacity/i);
    release();
    await first;
    await second;
  });
});
