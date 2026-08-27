import { describe, expect, it } from 'vitest';
import { createChannelAccount } from '../channel-accounts.js';
import { initDatabase } from '../db/migration.js';
import { createUser } from '../users.js';
import { createWorkspace } from '../workspaces.js';
import { buildChannelJid } from './channel-address.js';
import { createChannelCommandService, parseChannelCommand } from './channel-commands.js';
import { createChannelMountService } from './channel-mount-service.js';

function setup() {
  const db = initDatabase(':memory:');
  const ownerUserId = 'user_commands';
  createUser(db, { id: ownerUserId, username: ownerUserId, password_hash: 'test', display_name: '命令测试', role: 'admin', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  const workspace = createWorkspace(db, ownerUserId, { name: '主工作区' })!;
  const second = createWorkspace(db, ownerUserId, { name: '第二工作区' })!;
  const account = createChannelAccount(db, ownerUserId, { provider: 'telegram', name: '机器人', default_workspace_jid: workspace.jid });
  expect(account.ok).toBe(true);
  const accountId = db.prepare('SELECT id FROM channel_accounts LIMIT 1').get() as { id: string };
  const mounts = createChannelMountService(db);
  const commands = createChannelCommandService({ db, mounts });
  return { db, ownerUserId, workspace, second, accountId: accountId.id, commands, mounts };
}

describe('渠道命令', () => {
  it('解析全部核心命令和参数', () => {
    expect(parseChannelCommand('/list')).toEqual({ kind: 'list' });
    expect(parseChannelCommand('/bind web:123')).toEqual({ kind: 'bind', workspace: 'web:123' });
    expect(parseChannelCommand('/new 研发会话')).toEqual({ kind: 'new', name: '研发会话' });
    expect(parseChannelCommand('/clear')).toEqual({ kind: 'clear' });
    expect(parseChannelCommand('/route 修复代码并发布')).toEqual({ kind: 'route', message: '修复代码并发布' });
    expect(parseChannelCommand('/single 你好')).toEqual({ kind: 'single', message: '你好' });
    expect(parseChannelCommand('普通消息')).toBeNull();
  });

  it('在渠道入口执行绑定、查询、创建和解绑', async () => {
    const { db, ownerUserId, workspace, second, accountId, commands, mounts } = setup();
    const groupJid = buildChannelJid({ provider: 'telegram', externalChatId: '-100', channelAccountId: accountId });
    const groupMessage = { provider: 'telegram' as const, accountId, chatJid: groupJid, externalChatId: '-100', conversation: 'group' as const, senderId: 'u1', text: '' };

    const list = await commands.execute('/list', { ownerUserId, message: groupMessage });
    expect(list.reply).toContain(workspace.name);
    expect(list.reply).toContain(second.name);

    const bind = await commands.execute(`/bind ${workspace.jid}`, { ownerUserId, message: groupMessage });
    expect(bind.reply).toContain('已绑定');
    const routed = createChannelCommandService({
      db,
      mounts,
      onRouteMessage: async ({ message, route }) => `编排 ${route.workspaceJid}: ${message.text}`,
      onSingleMessage: async ({ message }) => `单 Agent：${message.text}`,
    });
    expect((await routed.execute('/route 修复代码并发布', { ownerUserId, message: groupMessage })).reply).toContain(`编排 ${workspace.jid}`);
    expect((await routed.execute('/single 你好', { ownerUserId, message: groupMessage })).reply).toBe('单 Agent：你好');
    const where = await commands.execute('/where', { ownerUserId, message: groupMessage });
    expect(where.reply).toContain(workspace.jid);
    const status = await commands.execute('/status', { ownerUserId, message: groupMessage });
    expect(status.reply).toContain('已连接');

    const unbind = await commands.execute('/unbind', { ownerUserId, message: groupMessage });
    expect(unbind.reply).toContain('已解绑');
    expect(db.prepare('SELECT COUNT(*) AS count FROM channel_mounts').get()).toMatchObject({ count: 0 });

    const privateJid = buildChannelJid({ provider: 'telegram', externalChatId: '100', channelAccountId: accountId });
    const privateMessage = { ...groupMessage, chatJid: privateJid, externalChatId: '100', conversation: 'private' as const };
    const created = await commands.execute('/new 研发', { ownerUserId, message: privateMessage });
    expect(created.reply).toContain('已创建');
    const cleared = await commands.execute('/clear', { ownerUserId, message: privateMessage });
    expect(cleared.reply).toContain('已清理');
  });
});
