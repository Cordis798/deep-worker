import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PiSdkRuntimeAdapter,
  type PiSdkRuntimeDependencies,
} from './pi-sdk-runtime.js';
import type { PiAgentSessionLike } from './pi-sdk-session.js';

const roots: string[] = [];

function fakeAgentSession(): PiAgentSessionLike {
  return {
    sessionId: 'sdk-id',
    isStreaming: false,
    messages: [],
    subscribe: () => () => undefined,
    prompt: async () => undefined,
    steer: async () => undefined,
    followUp: async () => undefined,
    abort: async () => undefined,
    compact: async () => undefined,
    dispose: () => undefined,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('PiSdkRuntimeAdapter', () => {
  it('creates a direct SDK session with isolated resources', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deep-worker-sdk-runtime-'));
    roots.push(root);
    const createAgentSession = vi.fn(async () => ({ session: fakeAgentSession() }));
    const reload = vi.fn(async () => undefined);
    const setRetryEnabled = vi.fn();
    const dependencies: PiSdkRuntimeDependencies = {
      createModelRuntime: vi.fn(async () => ({
        getModel: () => ({ provider: 'anthropic', id: 'model-a' }),
        registerProvider: vi.fn(),
        setRuntimeApiKey: vi.fn(async () => undefined),
      })),
      createSettingsManager: vi.fn(() => ({ setRetryEnabled })),
      createResourceLoader: vi.fn(() => ({ reload })),
      createSessionManager: vi.fn(() => ({ kind: 'new-session' })),
      openSessionManager: vi.fn(() => ({ kind: 'restored-session' })),
      createAgentSession,
    };
    const statuses: unknown[] = [];
    const runtime = new PiSdkRuntimeAdapter({ dependencies });

    const session = await runtime.createSession({
      sessionId: 'app-session',
      cwd: path.join(root, 'workspace'),
      sessionDir: path.join(root, 'sessions'),
      provider: {
        provider: 'anthropic',
        modelId: 'model-a',
        env: { ANTHROPIC_API_KEY: 'secret' },
      },
      onContextStatus: (status) => statuses.push(status),
    });

    expect(session.sessionId).toBe('sdk-id');
    expect(setRetryEnabled).toHaveBeenCalledWith(false);
    expect(reload).toHaveBeenCalledOnce();
    expect(statuses).toEqual([{ status: 'new' }]);
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: path.join(root, 'workspace'),
        tools: ['bash'],
        sessionManager: { kind: 'new-session' },
        model: { provider: 'anthropic', id: 'model-a' },
      }),
    );
  });
});
