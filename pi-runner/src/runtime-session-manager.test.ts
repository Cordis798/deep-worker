import { describe, expect, it, vi } from 'vitest';
import {
  RuntimeSessionManager,
  type ManagedRuntimeSessionConfig,
} from './runtime-session-manager.js';
import type { AgentRuntime, RuntimeSession } from './runtime.js';

function fakeSession(id: string): RuntimeSession {
  return {
    sessionId: id,
    isStreaming: false,
    prompt: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn(),
    abort: vi.fn(),
    compact: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    dispose: vi.fn(),
  };
}

function config(overrides: Partial<ManagedRuntimeSessionConfig> = {}): ManagedRuntimeSessionConfig {
  return {
    sessionId: 'session-1',
    identityHash: 'identity-a',
    capabilityHash: 'capability-a',
    providerHash: 'provider-a',
    ...overrides,
  };
}

describe('RuntimeSessionManager', () => {
  it('reuses a warm session while identity, capabilities and provider stay stable', async () => {
    const session = fakeSession('sdk-session');
    const runtime: AgentRuntime = {
      kind: 'pi',
      createSession: vi.fn(async () => session),
      close: vi.fn(async () => undefined),
    };
    const manager = new RuntimeSessionManager({ baseDir: 'runtime-data', runtime });

    expect(await manager.getOrCreate(config())).toBe(session);
    expect(await manager.getOrCreate(config())).toBe(session);
    expect(runtime.createSession).toHaveBeenCalledTimes(1);
  });

  it('disposes and recreates a session when the capability hash changes', async () => {
    const first = fakeSession('first');
    const second = fakeSession('second');
    const runtime: AgentRuntime = {
      kind: 'pi',
      createSession: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
      close: vi.fn(async () => undefined),
    };
    const manager = new RuntimeSessionManager({ baseDir: 'runtime-data', runtime });

    await manager.getOrCreate(config());
    expect(
      await manager.getOrCreate(config({ capabilityHash: 'capability-b' })),
    ).toBe(second);
    expect(first.dispose).toHaveBeenCalledOnce();
  });
});
