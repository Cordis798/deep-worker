import { describe, expect, it } from 'vitest';
import type { PiRpcClientOptions } from './rpc-client.js';
import { PiSessionManager, type SessionClient } from './session-manager.js';

class FakeSessionClient implements SessionClient {
  starts = 0;
  closes = 0;
  async start(): Promise<void> {
    this.starts += 1;
  }
  async close(): Promise<void> {
    this.closes += 1;
  }
  async getState(): Promise<{ sessionId: string }> {
    return { sessionId: 'fake' };
  }
}

describe('PiSessionManager', () => {
  it('reuses sessions and invalidates identity/capability changes', async () => {
    const clients: FakeSessionClient[] = [];
    const manager = new PiSessionManager({
      baseDir: 'C:\\tmp\\deep-worker-pi-test',
      idleTimeoutMs: 100,
      createClient: (_options: PiRpcClientOptions) => {
        const client = new FakeSessionClient();
        clients.push(client);
        return client;
      },
    });
    const first = await manager.getOrCreate({
      sessionId: 's1',
      identityHash: 'a',
      capabilityHash: 'x',
    });
    const reused = await manager.getOrCreate({
      sessionId: 's1',
      identityHash: 'a',
      capabilityHash: 'x',
    });
    expect(reused).toBe(first);
    expect(clients).toHaveLength(1);
    const replaced = await manager.getOrCreate({
      sessionId: 's1',
      identityHash: 'b',
      capabilityHash: 'x',
    });
    expect(replaced).not.toBe(first);
    expect(clients[0].closes).toBe(1);
    await manager.sweepIdle(Date.now() + 200);
    expect(clients[1].closes).toBe(1);
    await manager.closeAll();
  });
});
