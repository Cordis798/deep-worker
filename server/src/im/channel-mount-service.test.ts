import { describe, expect, it } from 'vitest';
import { createChannelAccount } from '../channel-accounts.js';
import { initDatabase } from '../db/migration.js';
import { createRuntimeSession } from '../runtime-sessions.js';
import { createUser } from '../users.js';
import { createWorkspace } from '../workspaces.js';
import { createChannelMountService } from './channel-mount-service.js';
import { buildChannelJid } from './channel-address.js';

function setup() {
  const db = initDatabase(':memory:');
  const ownerUserId = 'user_mounts';
  createUser(db, {
    id: ownerUserId,
    username: ownerUserId,
    password_hash: 'test',
    display_name: '挂载测试',
    role: 'admin',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const workspace = createWorkspace(db, ownerUserId, { name: '渠道工作区' })!;
  const secondWorkspace = createWorkspace(db, ownerUserId, { name: '第二工作区' })!;
  const accountId = 'ca_mount';
  createChannelAccount(db, ownerUserId, {
    provider: 'feishu',
    name: '飞书主账号',
    is_default: true,
    default_workspace_jid: workspace.jid,
  });
  db.prepare('UPDATE channel_accounts SET id = ? WHERE owner_user_id = ?').run(accountId, ownerUserId);
  return { db, ownerUserId, workspace, secondWorkspace, accountId };
}

describe('渠道挂载解析', () => {
  it('私聊首次进入时按账号默认工作区创建并复用 Runtime Session', () => {
    const { db, ownerUserId, workspace, accountId } = setup();
    const service = createChannelMountService(db);
    const chatJid = buildChannelJid({ provider: 'feishu', externalChatId: 'ou_1', channelAccountId: accountId });
    const message = {
      provider: 'feishu' as const,
      accountId,
      chatJid,
      externalChatId: 'ou_1',
      conversation: 'private' as const,
      senderId: 'ou_1',
      senderName: '用户一',
      text: '你好',
    };

    const first = service.resolveInbound({ ownerUserId, message });
    expect(first.status).toBe('resolved');
    if (first.status !== 'resolved') return;
    expect(first.route.workspaceJid).toBe(workspace.jid);
    expect(first.route.sessionId).toBeTruthy();

    const second = service.resolveInbound({ ownerUserId, message: { ...message, text: '继续' } });
    expect(second.status).toBe('resolved');
    if (second.status !== 'resolved') return;
    expect(second.route.sessionId).toBe(first.route.sessionId);
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_channel_mounts').get()).toMatchObject({ count: 1 });
  });

  it('群聊必须绑定工作区，原生话题各自建立独立 Session', () => {
    const { db, ownerUserId, workspace, accountId } = setup();
    const service = createChannelMountService(db);
    const base = buildChannelJid({ provider: 'feishu', externalChatId: 'oc_group', channelAccountId: accountId });
    const unbound = service.resolveInbound({
      ownerUserId,
      message: {
        provider: 'feishu', accountId, chatJid: base, externalChatId: 'oc_group', conversation: 'group', senderId: 'ou_1', text: '未绑定',
      },
    });
    expect(unbound.status).toBe('unbound');

    expect(service.bindWorkspace({ ownerUserId, chatJid: base, workspaceJid: workspace.jid, accountId }).ok).toBe(true);
    const topicA = service.resolveInbound({
      ownerUserId,
      message: {
        provider: 'feishu', accountId, chatJid: `${base}#thread:topic-a#root:root-a`, externalChatId: 'oc_group', conversation: 'group', senderId: 'ou_1', text: '话题 A', threadId: 'topic-a', rootMessageId: 'root-a',
      },
    });
    const topicB = service.resolveInbound({
      ownerUserId,
      message: {
        provider: 'feishu', accountId, chatJid: `${base}#thread:topic-b#root:root-b`, externalChatId: 'oc_group', conversation: 'group', senderId: 'ou_2', text: '话题 B', threadId: 'topic-b', rootMessageId: 'root-b',
      },
    });
    expect(topicA.status).toBe('resolved');
    expect(topicB.status).toBe('resolved');
    if (topicA.status !== 'resolved' || topicB.status !== 'resolved') return;
    expect(topicA.route.workspaceJid).toBe(workspace.jid);
    expect(topicA.route.sessionId).not.toBe(topicB.route.sessionId);
    expect(topicA.route.contextType).toBe('thread');
    expect(db.prepare('SELECT COUNT(*) AS count FROM im_context_bindings').get()).toMatchObject({ count: 2 });
  });

  it('同一外部聊天在不同账号下保持挂载隔离', () => {
    const { db, ownerUserId, workspace, secondWorkspace, accountId } = setup();
    createChannelAccount(db, ownerUserId, { provider: 'feishu', name: '飞书副账号', default_workspace_jid: secondWorkspace.jid });
    const secondAccountId = db.prepare("SELECT id FROM channel_accounts WHERE name = '飞书副账号'").get() as { id: string };
    const service = createChannelMountService(db);
    const firstJid = buildChannelJid({ provider: 'feishu', externalChatId: 'oc_same', channelAccountId: accountId });
    const secondJid = buildChannelJid({ provider: 'feishu', externalChatId: 'oc_same', channelAccountId: secondAccountId.id });
    expect(service.bindWorkspace({ ownerUserId, chatJid: firstJid, workspaceJid: workspace.jid, accountId }).ok).toBe(true);
    expect(service.bindWorkspace({ ownerUserId, chatJid: secondJid, workspaceJid: secondWorkspace.jid, accountId: secondAccountId.id }).ok).toBe(true);
    const first = service.resolveInbound({ ownerUserId, message: { provider: 'feishu', accountId, chatJid: firstJid, externalChatId: 'oc_same', conversation: 'group', senderId: 'a', text: 'a' } });
    const second = service.resolveInbound({ ownerUserId, message: { provider: 'feishu', accountId: secondAccountId.id, chatJid: secondJid, externalChatId: 'oc_same', conversation: 'group', senderId: 'b', text: 'b' } });
    expect(first.status).toBe('resolved');
    expect(second.status).toBe('resolved');
    if (first.status !== 'resolved' || second.status !== 'resolved') return;
    expect(first.route.workspaceJid).toBe(workspace.jid);
    expect(second.route.workspaceJid).toBe(secondWorkspace.jid);
  });
});
