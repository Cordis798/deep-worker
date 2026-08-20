import { describe, expect, it } from 'vitest';
import { createChannelAccount, getOwnedChannelAccount } from '../channel-accounts.js';
import { initDatabase } from '../db/migration.js';
import { listReadyChannelDeliveries } from '../channel-reliability.js';
import { createUser } from '../users.js';
import { createWorkspace } from '../workspaces.js';
import { FakeTransport } from './fake-transport.js';
import { ChannelManager } from './channel-manager.js';

const providers = ['telegram', 'discord', 'whatsapp', 'feishu', 'qq', 'dingtalk', 'wechat'] as const;

function setup(provider: (typeof providers)[number]) {
  const db = initDatabase(':memory:');
  const ownerUserId = 'user_manager';
  createUser(db, { id: ownerUserId, username: ownerUserId, password_hash: 'test', display_name: '管理测试', role: 'admin', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  const workspace = createWorkspace(db, ownerUserId, { name: '消息工作区' })!;
  createChannelAccount(db, ownerUserId, { provider, name: `${provider} 账号`, default_workspace_jid: workspace.jid, credentials: { token: 'encrypted-token' } });
  const account = db.prepare('SELECT * FROM channel_accounts WHERE owner_user_id = ?').get(ownerUserId) as { id: string };
  return { db, ownerUserId, workspace, accountId: account.id };
}

describe('渠道管理器消息闭环', () => {
  it.each(providers)('%s 能将入站消息路由到 Agent 并回复原聊天', async (provider) => {
    const { db, ownerUserId, accountId } = setup(provider);
    const transport = new FakeTransport();
    const replies: string[] = [];
    const manager = new ChannelManager({
      db,
      transportFactory: () => transport,
      onAgentMessage: async ({ message }) => {
        replies.push(message.text);
        return `回复：${message.text}`;
      },
      retryBaseMs: 0,
    });
    await manager.connectAccount(ownerUserId, accountId);
    transport.emitMessage({ externalChatId: 'chat-1', conversation: 'private', senderId: 'user-1', text: '你好' });
    await manager.waitForIdle();
    expect(replies).toEqual(['你好']);
    expect(transport.sent.find((item) => item.kind === 'message')).toMatchObject({ kind: 'message', text: '回复：你好', target: { externalChatId: 'chat-1' } });
    expect(listReadyChannelDeliveries(db)).toHaveLength(0);
    await manager.reconnectAccount(ownerUserId, accountId);
    transport.emitMessage({ externalChatId: 'chat-1', conversation: 'private', senderId: 'user-1', text: '再次发送' });
    await manager.waitForIdle();
    expect(replies).toEqual(['你好', '再次发送']);
    await manager.close();
  });

  it('投递失败后保存原地址，重试成功时不切换默认账号', async () => {
    const { db, ownerUserId, accountId } = setup('telegram');
    const transport = new FakeTransport();
    const manager = new ChannelManager({ db, transportFactory: () => transport, retryBaseMs: 0 });
    await manager.connectAccount(ownerUserId, accountId);
    const target = `telegram:100#account:${accountId}`;
    transport.failNextDelivery();
    await manager.sendMessage(ownerUserId, target, '稍后发送');
    expect(listReadyChannelDeliveries(db)).toHaveLength(1);
    await manager.flushPending();
    expect(listReadyChannelDeliveries(db)).toHaveLength(0);
    expect(transport.sent).toHaveLength(1);
    expect((getOwnedChannelAccount(db, ownerUserId, accountId)!).id).toBe(accountId);
    await manager.close();
  });
});
