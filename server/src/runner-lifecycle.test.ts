import { describe, expect, it } from 'vitest';
import { runnerLifecycle } from './runner-lifecycle.js';

describe('运行器生命周期', () => {
  it('暂停期间阻塞新执行，嵌套暂停全部解除后才恢复', async () => {
    while (runnerLifecycle.isPaused()) runnerLifecycle.resume();
    runnerLifecycle.pause('第一次暂停');
    runnerLifecycle.pause('第二次暂停');
    let resumed = false;
    const waiting = runnerLifecycle.waitUntilResumed().then(() => { resumed = true; });
    await Promise.resolve();
    expect(resumed).toBe(false);
    expect(runnerLifecycle.reason()).toBe('第二次暂停');
    runnerLifecycle.resume();
    await Promise.resolve();
    expect(resumed).toBe(false);
    runnerLifecycle.resume();
    await waiting;
    expect(resumed).toBe(true);
    expect(runnerLifecycle.isPaused()).toBe(false);
  });
});
