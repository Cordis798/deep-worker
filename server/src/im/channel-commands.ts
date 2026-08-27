import type Database from 'better-sqlite3';
import { getOwnedChannelAccount } from '../channel-accounts.js';
import { listAccessibleWorkspaces } from '../workspace-acl.js';
import type { ChannelInboundMessage, ChannelConnectionState } from './channel-adapter.js';
import type { createChannelMountService } from './channel-mount-service.js';

type MountService = ReturnType<typeof createChannelMountService>;

export type ChannelCommand =
  | { kind: 'list' }
  | { kind: 'status' }
  | { kind: 'where' }
  | { kind: 'bind'; workspace: string }
  | { kind: 'unbind' }
  | { kind: 'new'; name?: string }
  | { kind: 'route'; message: string }
  | { kind: 'single'; message: string }
  | { kind: 'approve'; planId: string }
  | { kind: 'reject'; planId: string }
  | { kind: 'cancel'; planId: string }
  | { kind: 'clear' }
  | { kind: 'help' }
  | { kind: 'unknown'; name: string };

export interface ChannelCommandContext {
  ownerUserId: string;
  message: ChannelInboundMessage;
  connection?: ChannelConnectionState;
}

export interface ChannelCommandResult {
  handled: boolean;
  reply: string;
}

export function parseChannelCommand(value: string): ChannelCommand | null {
  const text = value.trim();
  if (!text.startsWith('/')) return null;
  const [rawName, ...parts] = text.split(/\s+/);
  const name = rawName!.slice(1).toLowerCase();
  if (name === 'list') return { kind: 'list' };
  if (name === 'status') return { kind: 'status' };
  if (name === 'where') return { kind: 'where' };
  if (name === 'unbind') return { kind: 'unbind' };
  if (name === 'clear') return { kind: 'clear' };
  if (name === 'help') return { kind: 'help' };
  if (name === 'bind') return { kind: 'bind', workspace: parts.join(' ').trim() };
  if (name === 'new') return { kind: 'new', ...(parts.length ? { name: parts.join(' ').trim() } : {}) };
  if (name === 'route') return { kind: 'route', message: parts.join(' ').trim() };
  if (name === 'single') return { kind: 'single', message: parts.join(' ').trim() };
  if (name === 'approve') return { kind: 'approve', planId: parts.join(' ').trim() };
  if (name === 'reject') return { kind: 'reject', planId: parts.join(' ').trim() };
  if (name === 'cancel') return { kind: 'cancel', planId: parts.join(' ').trim() };
  return { kind: 'unknown', name };
}

const HELP_TEXT = '可用命令：/list、/status、/where、/bind <工作区 JID>、/unbind、/new [名称]、/route <跨岗位任务>、/single <普通对话>、/approve <计划 ID>、/reject <计划 ID>、/cancel <计划 ID>、/clear、/help';

export function createChannelCommandService(options: {
  db: Database.Database;
  mounts: MountService;
  clearSession?: (sessionId: string) => Promise<void> | void;
  onRouteMessage?: (input: { ownerUserId: string; message: ChannelInboundMessage; route: NonNullable<Extract<ReturnType<MountService['resolveInbound']>, { status: 'resolved' }>['route']> }) => Promise<string | null>;
  onSingleMessage?: (input: { ownerUserId: string; message: ChannelInboundMessage; route: NonNullable<Extract<ReturnType<MountService['resolveInbound']>, { status: 'resolved' }>['route']> }) => Promise<string | null>;
  onRouterApproval?: (input: { ownerUserId: string; planId: string; approved: boolean; message: ChannelInboundMessage; route: NonNullable<Extract<ReturnType<MountService['resolveInbound']>, { status: 'resolved' }>['route']> }) => Promise<string | null>;
  onRouterCancel?: (input: { ownerUserId: string; planId: string; message: ChannelInboundMessage; route: NonNullable<Extract<ReturnType<MountService['resolveInbound']>, { status: 'resolved' }>['route']> }) => Promise<string | null>;
}) {
  async function execute(value: string, context: ChannelCommandContext): Promise<ChannelCommandResult> {
    const command = parseChannelCommand(value);
    if (!command) return { handled: false, reply: '' };
    if (command.kind === 'help') return { handled: true, reply: HELP_TEXT };
    if (command.kind === 'unknown') return { handled: true, reply: `未知命令 /${command.name}。${HELP_TEXT}` };

    if (command.kind === 'list') {
      const workspaces = listAccessibleWorkspaces(options.db, context.ownerUserId);
      return { handled: true, reply: workspaces.length ? `可用工作区：\n${workspaces.map((workspace) => `- ${workspace.name} (${workspace.jid})`).join('\n')}` : '暂无可用工作区。' };
    }

    if (command.kind === 'bind') {
      if (context.message.conversation !== 'group') return { handled: true, reply: '只有群聊可以绑定工作区。' };
      const workspace = listAccessibleWorkspaces(options.db, context.ownerUserId).find((item) => item.jid === command.workspace || item.name === command.workspace);
      if (!workspace) return { handled: true, reply: '工作区不存在，请先使用 /list 查看。' };
      const result = options.mounts.bindWorkspace({ ownerUserId: context.ownerUserId, chatJid: context.message.chatJid, workspaceJid: workspace.jid, accountId: context.message.accountId });
      if (!result.ok) return { handled: true, reply: result.reason === 'exists' ? '当前群聊已经绑定其他工作区。' : '工作区绑定失败。' };
      return { handled: true, reply: `已绑定工作区：${workspace.name} (${workspace.jid})` };
    }

    if (command.kind === 'unbind') {
      const ok = options.mounts.unbind({ ownerUserId: context.ownerUserId, chatJid: context.message.chatJid });
      return { handled: true, reply: ok ? '已解绑当前聊天。' : '当前聊天没有绑定。' };
    }

    if (command.kind === 'new') {
      if (context.message.conversation !== 'private') return { handled: true, reply: '只有私聊可以创建独立 Runtime Session。' };
      const result = options.mounts.createPrivateSession({ ownerUserId: context.ownerUserId, message: context.message, name: command.name });
      return result.status === 'resolved' ? { handled: true, reply: `已创建 Runtime Session：${result.route.sessionId}` } : { handled: true, reply: '创建 Runtime Session 失败，请检查账号默认工作区。' };
    }

    const resolved = options.mounts.resolveInbound({ ownerUserId: context.ownerUserId, message: context.message });
    if (command.kind === 'approve' || command.kind === 'reject' || command.kind === 'cancel') {
      if (!command.planId) return { handled: true, reply: command.kind === 'approve' ? '用法：/approve <计划 ID>' : command.kind === 'reject' ? '用法：/reject <计划 ID>' : '用法：/cancel <计划 ID>' };
      if (resolved.status !== 'resolved') return { handled: true, reply: resolved.status === 'unbound' ? '当前群聊尚未绑定工作区。' : '当前聊天暂时没有可用路由。' };
      if (command.kind === 'cancel' ? !options.onRouterCancel : !options.onRouterApproval) return { handled: true, reply: command.kind === 'cancel' ? '当前渠道未启用取消操作。' : '当前渠道未启用审批操作。' };
      const reply = command.kind === 'cancel'
        ? await options.onRouterCancel?.({ ownerUserId: context.ownerUserId, planId: command.planId, message: context.message, route: resolved.route })
        : await options.onRouterApproval?.({ ownerUserId: context.ownerUserId, planId: command.planId, approved: command.kind === 'approve', message: context.message, route: resolved.route });
      return { handled: true, reply: reply ?? (command.kind === 'cancel' ? '取消操作已提交。' : '审批操作已提交。') };
    }
    if (command.kind === 'route' || command.kind === 'single') {
      if (!command.message) return { handled: true, reply: command.kind === 'route' ? '用法：/route <跨岗位任务>' : '用法：/single <普通对话>' };
      if (resolved.status !== 'resolved') return { handled: true, reply: resolved.status === 'unbound' ? '当前群聊尚未绑定工作区。' : '当前聊天暂时没有可用路由。' };
      const handler = command.kind === 'route' ? options.onRouteMessage : options.onSingleMessage;
      if (!handler) return { handled: true, reply: '当前渠道未启用该路由模式。' };
      const reply = await handler({ ownerUserId: context.ownerUserId, message: { ...context.message, text: command.message }, route: resolved.route });
      return { handled: true, reply: reply ?? '任务已提交。' };
    }
    if (command.kind === 'where') {
      return resolved.status === 'resolved' ? { handled: true, reply: `当前路由：工作区 ${resolved.route.workspaceJid}，Session ${resolved.route.sessionId}` } : { handled: true, reply: resolved.status === 'unbound' ? '当前群聊尚未绑定工作区。' : '当前聊天暂时没有可用路由。' };
    }
    if (command.kind === 'clear') {
      if (resolved.status !== 'resolved') return { handled: true, reply: '当前聊天没有可清理的 Runtime Session。' };
      await options.clearSession?.(resolved.route.sessionId);
      return { handled: true, reply: `已清理 Session ${resolved.route.sessionId} 的上下文。` };
    }

    const account = getOwnedChannelAccount(options.db, context.ownerUserId, context.message.accountId);
    const status = context.connection?.status ?? 'connected';
    return { handled: true, reply: `渠道状态：${status === 'connected' ? '已连接' : status}\n账号：${account?.name ?? context.message.accountId}\n挂载：${resolved.status === 'resolved' ? '已建立' : resolved.status === 'unbound' ? '未绑定' : '不可用'}` };
  }

  return { execute };
}
