import type Database from 'better-sqlite3';
import { getOwnedChannelAccount } from './channel-accounts.js';
import { getRuntimeSessionById, listRuntimeSessions } from './runtime-sessions.js';
import { getOwnedWorkspace } from './workspaces.js';
import { canWorkspaceAction } from './workspace-acl.js';

export type Db = Database.Database;

export type ChannelType = 'group' | 'private';

export interface ChannelMountRow {
  im_jid: string;
  channel_type: string;
  workspace_jid: string;
  owner_user_id: string;
  channel_account_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentChannelMountRow {
  im_jid: string;
  channel_type: string;
  workspace_jid: string;
  session_id: string;
  owner_user_id: string;
  channel_account_id: string | null;
  created_at: string;
  updated_at: string;
}

export function listWorkspaceMounts(
  db: Db,
  ownerUserId: string,
  workspaceJid: string,
): ChannelMountRow[] | undefined {
  if (!canWorkspaceAction(db, ownerUserId, workspaceJid, 'view')) return undefined;
  return db
    .prepare(
      'SELECT * FROM channel_mounts WHERE workspace_jid = ? ORDER BY created_at ASC',
    )
    .all(workspaceJid) as ChannelMountRow[];
}

export function listSessionMounts(
  db: Db,
  ownerUserId: string,
  workspaceJid: string,
  sessionId: string,
): AgentChannelMountRow[] | undefined {
  if (!canWorkspaceAction(db, ownerUserId, workspaceJid, 'view')) return undefined;
  const session = getRuntimeSessionById(db, sessionId);
  if (!session || session.workspace_jid !== workspaceJid) return undefined;
  return db
    .prepare(
      'SELECT * FROM agent_channel_mounts WHERE session_id = ? ORDER BY created_at ASC',
    )
    .all(sessionId) as AgentChannelMountRow[];
}

export function countWorkspaceChannelMounts(
  db: Db,
  ownerUserId: string,
  workspaceJid: string,
): number | undefined {
  if (!getOwnedWorkspace(db, ownerUserId, workspaceJid)) return undefined;
  const workspaceMounts = db
    .prepare('SELECT COUNT(*) AS count FROM channel_mounts WHERE workspace_jid = ?')
    .get(workspaceJid) as { count: number };
  const sessionMounts = db
    .prepare(
      'SELECT COUNT(*) AS count FROM agent_channel_mounts WHERE workspace_jid = ?',
    )
    .get(workspaceJid) as { count: number };
  return Number(workspaceMounts.count) + Number(sessionMounts.count);
}

function verifyChannelAccount(
  db: Db,
  ownerUserId: string,
  channelAccountId: string | undefined,
): boolean {
  if (!channelAccountId) return true;
  return !!getOwnedChannelAccount(db, ownerUserId, channelAccountId);
}

export interface BindWorkspaceResult {
  ok: boolean;
  reason?: 'not_found' | 'wrong_type' | 'account_not_found' | 'exists';
}

export function bindWorkspaceChat(
  db: Db,
  ownerUserId: string,
  workspaceJid: string,
  fields: {
    imJid: string;
    channelType: ChannelType;
    channelAccountId?: string;
  },
): BindWorkspaceResult {
  const ws = getOwnedWorkspace(db, ownerUserId, workspaceJid);
  if (!ws) return { ok: false, reason: 'not_found' };
  if (fields.channelType !== 'group') {
    return { ok: false, reason: 'wrong_type' };
  }
  if (!verifyChannelAccount(db, ownerUserId, fields.channelAccountId)) {
    return { ok: false, reason: 'account_not_found' };
  }
  const existing = db
    .prepare('SELECT im_jid FROM channel_mounts WHERE im_jid = ?')
    .get(fields.imJid);
  if (existing) return { ok: false, reason: 'exists' };
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO channel_mounts (
      im_jid, channel_type, workspace_jid, owner_user_id, channel_account_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fields.imJid,
    'group',
    workspaceJid,
    ownerUserId,
    fields.channelAccountId ?? null,
    now,
    now,
  );
  return { ok: true };
}

export function unbindWorkspaceChat(
  db: Db,
  ownerUserId: string,
  imJid: string,
): boolean {
  const result = db
    .prepare('DELETE FROM channel_mounts WHERE im_jid = ? AND owner_user_id = ?')
    .run(imJid, ownerUserId);
  return result.changes > 0;
}

export interface BindSessionResult {
  ok: boolean;
  reason?: 'not_found' | 'wrong_type' | 'account_not_found' | 'exists';
}

export function bindSessionChat(
  db: Db,
  ownerUserId: string,
  workspaceJid: string,
  sessionId: string,
  fields: {
    imJid: string;
    channelType: ChannelType;
    channelAccountId?: string;
  },
): BindSessionResult {
  const ws = getOwnedWorkspace(db, ownerUserId, workspaceJid);
  if (!ws) return { ok: false, reason: 'not_found' };
  const sessions = listRuntimeSessions(db, ownerUserId, workspaceJid);
  if (!sessions || !sessions.some((s) => s.id === sessionId)) {
    return { ok: false, reason: 'not_found' };
  }
  if (fields.channelType !== 'private') {
    return { ok: false, reason: 'wrong_type' };
  }
  if (!verifyChannelAccount(db, ownerUserId, fields.channelAccountId)) {
    return { ok: false, reason: 'account_not_found' };
  }
  const existing = db
    .prepare('SELECT im_jid FROM agent_channel_mounts WHERE im_jid = ?')
    .get(fields.imJid);
  if (existing) return { ok: false, reason: 'exists' };
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_channel_mounts (
      im_jid, channel_type, workspace_jid, session_id, owner_user_id,
      channel_account_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fields.imJid,
    'private',
    workspaceJid,
    sessionId,
    ownerUserId,
    fields.channelAccountId ?? null,
    now,
    now,
  );
  return { ok: true };
}

export function unbindSessionChat(
  db: Db,
  ownerUserId: string,
  imJid: string,
): boolean {
  const result = db
    .prepare(
      'DELETE FROM agent_channel_mounts WHERE im_jid = ? AND owner_user_id = ?',
    )
    .run(imJid, ownerUserId);
  return result.changes > 0;
}
