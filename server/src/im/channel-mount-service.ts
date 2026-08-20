import type Database from 'better-sqlite3';
import type { ChannelProvider } from '../channel-accounts.js';
import { getOwnedChannelAccount } from '../channel-accounts.js';
import { createRuntimeSession, getOwnedRuntimeSession } from '../runtime-sessions.js';
import type { RuntimeSessionRow } from '../runtime-sessions.js';
import { createWorkspace, getOwnedWorkspace } from '../workspaces.js';
import { bindSessionChat, bindWorkspaceChat } from '../channel-mounts.js';
import type { ChannelInboundMessage } from './channel-adapter.js';
import { channelConversationKey, parseChannelJid } from './channel-address.js';
import { CHANNEL_CAPABILITIES } from './channel-capabilities.js';
import { resolveNativeContext, type NativeContext } from './channel-native-context.js';

export type Db = Database.Database;

export interface ChannelRoute {
  ownerUserId: string;
  provider: ChannelProvider;
  accountId: string;
  sourceJid: string;
  chatJid: string;
  workspaceJid: string;
  sessionId: string;
  contextType: 'private' | 'group' | 'thread';
  contextId: string;
  nativeContext: NativeContext | null;
}

export type ResolveInboundResult =
  | { status: 'resolved'; route: ChannelRoute; created: boolean }
  | { status: 'unbound'; reason: 'workspace_binding_required' }
  | { status: 'unavailable'; reason: 'account_not_found' | 'account_disabled' | 'default_workspace_missing' | 'session_archived' };

interface ContextRow {
  source_jid: string;
  context_type: string;
  context_id: string;
  workspace_jid: string;
  session_id: string | null;
}

interface MountRow {
  im_jid: string;
  workspace_jid: string;
  session_id?: string;
  channel_account_id: string | null;
}

function getWorkspaceMount(db: Db, sourceJid: string): MountRow | undefined {
  return db.prepare('SELECT im_jid, workspace_jid, channel_account_id FROM channel_mounts WHERE im_jid = ?').get(sourceJid) as MountRow | undefined;
}

function getSessionMount(db: Db, sourceJid: string): MountRow | undefined {
  return db.prepare('SELECT im_jid, workspace_jid, session_id, channel_account_id FROM agent_channel_mounts WHERE im_jid = ?').get(sourceJid) as MountRow | undefined;
}

function getContext(db: Db, sourceJid: string, contextType: string, contextId: string): ContextRow | undefined {
  return db.prepare('SELECT * FROM im_context_bindings WHERE source_jid = ? AND context_type = ? AND context_id = ?').get(sourceJid, contextType, contextId) as ContextRow | undefined;
}

function insertContext(db: Db, row: ContextRow): void {
  db.prepare(
    `INSERT INTO im_context_bindings (source_jid, context_type, context_id, workspace_jid, session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.source_jid, row.context_type, row.context_id, row.workspace_jid, row.session_id, new Date().toISOString(), new Date().toISOString());
}

function sessionName(contextType: 'private' | 'group' | 'thread', nativeContext: NativeContext | null): string {
  if (contextType === 'thread') return `渠道话题：${nativeContext?.title ?? '未命名话题'}`;
  if (contextType === 'private') return '渠道私聊';
  return '渠道群聊';
}

export function createChannelMountService(db: Db) {
  function createSession(ownerUserId: string, workspaceJid: string, contextType: 'private' | 'group' | 'thread', nativeContext: NativeContext | null): RuntimeSessionRow | undefined {
    const result = createRuntimeSession(db, ownerUserId, workspaceJid, { name: sessionName(contextType, nativeContext) });
    return result.ok && result.id ? getOwnedRuntimeSession(db, ownerUserId, workspaceJid, result.id) : undefined;
  }

  function resolveInbound(input: { ownerUserId: string; message: ChannelInboundMessage }): ResolveInboundResult {
    const { ownerUserId, message } = input;
    const account = getOwnedChannelAccount(db, ownerUserId, message.accountId);
    if (!account || account.provider !== message.provider) return { status: 'unavailable', reason: 'account_not_found' };
    if (account.enabled !== 1) return { status: 'unavailable', reason: 'account_disabled' };
    const sourceJid = channelConversationKey(message.chatJid);
    const nativeContext = resolveNativeContext(message);
    const capabilities = CHANNEL_CAPABILITIES[message.provider];

    if (message.conversation === 'group') {
      const mount = getWorkspaceMount(db, sourceJid) ?? getWorkspaceMount(db, message.chatJid);
      if (!mount) return { status: 'unbound', reason: 'workspace_binding_required' };
      const workspace = getOwnedWorkspace(db, ownerUserId, mount.workspace_jid);
      if (!workspace) return { status: 'unavailable', reason: 'default_workspace_missing' };
      const contextType = nativeContext && capabilities.supportsThreadMap ? 'thread' : 'group';
      const contextId = contextType === 'thread' ? nativeContext!.contextId : 'default';
      const existing = getContext(db, sourceJid, contextType, contextId);
      if (existing?.session_id) {
        const session = getOwnedRuntimeSession(db, ownerUserId, workspace.jid, existing.session_id);
        if (session?.status === 'active') return { status: 'resolved', created: false, route: { ownerUserId, provider: message.provider, accountId: message.accountId, sourceJid, chatJid: message.chatJid, workspaceJid: workspace.jid, sessionId: session.id, contextType, contextId, nativeContext } };
        return { status: 'unavailable', reason: 'session_archived' };
      }
      const session = createSession(ownerUserId, workspace.jid, contextType, nativeContext);
      if (!session) return { status: 'unavailable', reason: 'default_workspace_missing' };
      insertContext(db, { source_jid: sourceJid, context_type: contextType, context_id: contextId, workspace_jid: workspace.jid, session_id: session.id });
      return { status: 'resolved', created: true, route: { ownerUserId, provider: message.provider, accountId: message.accountId, sourceJid, chatJid: message.chatJid, workspaceJid: workspace.jid, sessionId: session.id, contextType, contextId, nativeContext } };
    }

    const privateMount = getSessionMount(db, sourceJid) ?? getSessionMount(db, message.chatJid);
    if (privateMount?.session_id) {
      const session = getOwnedRuntimeSession(db, ownerUserId, privateMount.workspace_jid, privateMount.session_id);
      if (!session || session.status !== 'active') return { status: 'unavailable', reason: 'session_archived' };
      return { status: 'resolved', created: false, route: { ownerUserId, provider: message.provider, accountId: message.accountId, sourceJid, chatJid: message.chatJid, workspaceJid: privateMount.workspace_jid, sessionId: session.id, contextType: 'private', contextId: sourceJid, nativeContext: null } };
    }
    if (!account.default_workspace_jid || !getOwnedWorkspace(db, ownerUserId, account.default_workspace_jid)) return { status: 'unavailable', reason: 'default_workspace_missing' };
    const workspace = getOwnedWorkspace(db, ownerUserId, account.default_workspace_jid)!;
    const session = createSession(ownerUserId, workspace.jid, 'private', null);
    if (!session) return { status: 'unavailable', reason: 'default_workspace_missing' };
    const result = bindSessionChat(db, ownerUserId, workspace.jid, session.id, { imJid: sourceJid, channelType: 'private', channelAccountId: message.accountId });
    if (!result.ok) return { status: 'unavailable', reason: 'default_workspace_missing' };
    return { status: 'resolved', created: true, route: { ownerUserId, provider: message.provider, accountId: message.accountId, sourceJid, chatJid: message.chatJid, workspaceJid: workspace.jid, sessionId: session.id, contextType: 'private', contextId: sourceJid, nativeContext: null } };
  }

  function bindWorkspace(input: { ownerUserId: string; chatJid: string; workspaceJid: string; accountId: string }) {
    const parsed = parseChannelJid(input.chatJid);
    if (!parsed || parsed.channelAccountId !== input.accountId) return { ok: false as const, reason: 'account_not_found' as const };
    return bindWorkspaceChat(db, input.ownerUserId, input.workspaceJid, { imJid: channelConversationKey(input.chatJid), channelType: 'group', channelAccountId: input.accountId });
  }

  function bindSession(input: { ownerUserId: string; chatJid: string; workspaceJid: string; sessionId: string; accountId: string }) {
    const parsed = parseChannelJid(input.chatJid);
    if (!parsed || parsed.channelAccountId !== input.accountId) return { ok: false as const, reason: 'account_not_found' as const };
    return bindSessionChat(db, input.ownerUserId, channelConversationKey(input.chatJid), input.sessionId, { imJid: channelConversationKey(input.chatJid), channelType: 'private', channelAccountId: input.accountId });
  }

  function unbind(input: { ownerUserId: string; chatJid: string }): boolean {
    const sourceJid = channelConversationKey(input.chatJid);
    return db.transaction(() => {
      const workspace = db.prepare('DELETE FROM channel_mounts WHERE im_jid = ? AND owner_user_id = ?').run(sourceJid, input.ownerUserId);
      const session = db.prepare('DELETE FROM agent_channel_mounts WHERE im_jid = ? AND owner_user_id = ?').run(sourceJid, input.ownerUserId);
      db.prepare('DELETE FROM im_context_bindings WHERE source_jid = ?').run(sourceJid);
      return workspace.changes + session.changes > 0;
    })();
  }

  return { resolveInbound, bindWorkspace, bindSession, unbind };
}
