import { describe, expect, it } from 'vitest';
import { FakePiRunner } from '@deep-worker/pi-runner';
import { createChannelAccount } from '../channel-accounts.js';
import { initDatabase } from '../db/migration.js';
import { RuntimeRunnerService } from '../runtime-runner-service.js';
import { createUser } from '../users.js';
import { createWorkspace } from '../workspaces.js';
import { FakeTransport } from './fake-transport.js';
import { createRuntimeChannelManager } from './runtime-channel-manager.js';

describe('渠道到 Pi Runner 的闭环', () => {
  it('入站消息进入 Runtime Session 后将 Fake Pi 回复投递回原聊天', async () => {
    const db = initDatabase(':memory:');
    const ownerUserId = 'user_runtime_channel';
    createUser(db, { id: ownerUserId, username: ownerUserId, password_hash: 'test', display_name: '闭环测试', role: 'admin', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    const workspace = createWorkspace(db, ownerUserId, { name: 'Pi 渠道工作区' })!;
    createChannelAccount(db, ownerUserId, { provider: 'telegram', name: 'Pi 账号', default_workspace_jid: workspace.jid });
    const account = db.prepare('SELECT id FROM channel_accounts LIMIT 1').get() as { id: string };
    const transport = new FakeTransport();
    const runnerService = new RuntimeRunnerService({ db, runner: new FakePiRunner({ response: (request) => `Agent 已处理：${request.message}` }), retryBaseMs: 0 });
    const manager = createRuntimeChannelManager({ db, runnerService, transportFactory: () => transport });
    await manager.connectAccount(ownerUserId, account.id);
    transport.emitMessage({ messageId: 'm-1', externalChatId: '100', conversation: 'private', senderId: 'user-1', text: '执行任务' });
    await manager.waitForIdle();
    expect(transport.sent).toContainEqual(expect.objectContaining({ kind: 'message', text: 'Agent 已处理：执行任务', target: { externalChatId: '100' } }));
    expect(runnerService.streamHub).toBeDefined();
    await manager.close();
    await runnerService.close();
  });
});
