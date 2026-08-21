import { describe, expect, it } from 'vitest';
import { FakePiRunner } from '@deep-worker/pi-runner';
import { initDatabase } from './db/migration.js';
import { createProviderConfig, setProviderBalance } from './provider-store.js';
import { createUser } from './users.js';
import { createWorkspace } from './workspaces.js';
import { createRuntimeSession } from './runtime-sessions.js';
import { RuntimeRunnerService } from './runtime-runner-service.js';

describe('Provider 与 Runtime Runner 集成', () => {
  it('首个 Provider 失败后确定性切换并保持成功结果', async () => {
    const db = initDatabase(':memory:');
    createUser(db, { id: 'admin', username: 'admin', password_hash: 'x', display_name: '管理员', role: 'admin', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    const workspace = createWorkspace(db, 'admin', { name: 'Provider 工作区', execution_mode: 'host' })!;
    const sessionResult = createRuntimeSession(db, 'admin', workspace.jid, { name: 'Provider 会话' });
    expect(sessionResult.ok).toBe(true);
    const sessionId = sessionResult.ok ? sessionResult.id! : '';
    const first = createProviderConfig(db, 'admin', { name: '主 Provider', provider: 'primary', modelId: 'model-a' });
    createProviderConfig(db, 'admin', { name: '备 Provider', provider: 'backup', modelId: 'model-b' });
    setProviderBalance(db, 'admin', { strategy: 'failover', unhealthyThreshold: 1, recoveryIntervalMs: 60_000 });
    const runner = new FakePiRunner({ failuresBeforeSuccess: 1, response: '切换后完成' });
    const service = new RuntimeRunnerService({ db, runner, maxAttempts: 2, retryBaseMs: 0 });
    const result = await service.submit({ ownerUserId: 'admin', workspaceJid: workspace.jid, sessionId, message: '测试故障转移', idempotencyKey: 'provider-failover-1' });
    expect(result.reply).toBe('切换后完成');
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]?.provider?.provider).toBe(first.provider);
    expect(runner.calls[1]?.provider?.provider).toBe('backup');
    await service.close();
    db.close();
  });
});
