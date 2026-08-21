import crypto from 'node:crypto';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { DATA_DIR } from './config.js';
import { getOwnedAgentProfile } from './agent-profiles.js';
import { resolveRequestedExecutionMode, type ExecutionMode } from './execution-policy.js';

export type Db = Database.Database;

export interface WorkspaceRow {
  jid: string;
  folder: string;
  owner_user_id: string | null;
  name: string;
  agent_profile_id: string | null;
  status: string;
  execution_mode: 'host' | 'container' | string;
  is_home: number;
  created_at: string;
  updated_at: string;
}

export function generateWorkspaceJid(): string {
  return `web:${crypto.randomUUID()}`;
}

/** 返回工作区实际使用的宿主机目录。JID 仅作为标识，不能直接作为 Windows 目录名。 */
export function workspaceRoot(jid: string): string {
  const sanitized = jid.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const safeJid = sanitized === '.' || sanitized === '..' ? `_${sanitized}` : sanitized;
  return path.join(DATA_DIR, 'workspaces', safeJid || '_');
}

export function getWorkspaceById(db: Db, jid: string): WorkspaceRow | undefined {
  return db.prepare('SELECT * FROM workspaces WHERE jid = ?').get(jid) as
    | WorkspaceRow
    | undefined;
}

export function getOwnedWorkspace(
  db: Db,
  ownerUserId: string,
  jid: string,
): WorkspaceRow | undefined {
  return db
    .prepare('SELECT * FROM workspaces WHERE jid = ? AND owner_user_id = ?')
    .get(jid, ownerUserId) as WorkspaceRow | undefined;
}

export function listOwnedWorkspaces(
  db: Db,
  ownerUserId: string,
): WorkspaceRow[] {
  return db
    .prepare(
      'SELECT * FROM workspaces WHERE owner_user_id = ? ORDER BY is_home DESC, created_at ASC',
    )
    .all(ownerUserId) as WorkspaceRow[];
}

export interface CreateWorkspaceFields {
  jid?: string;
  folder?: string;
  name: string;
  agent_profile_id?: string | null;
  is_home?: boolean;
  execution_mode?: ExecutionMode;
  created_at?: string;
}

export function createWorkspace(
  db: Db,
  ownerUserId: string,
  fields: CreateWorkspaceFields,
): WorkspaceRow | undefined {
  if (fields.agent_profile_id) {
    const profile = getOwnedAgentProfile(db, ownerUserId, fields.agent_profile_id);
    if (!profile) return undefined;
  }
  const now = fields.created_at ?? new Date().toISOString();
  const execution = resolveRequestedExecutionMode(db, ownerUserId, fields.execution_mode);
  if (!execution.ok) return undefined;
  const jid = fields.jid ?? generateWorkspaceJid();
  const folder = fields.folder ?? jid;
  db.prepare(
    `INSERT INTO workspaces (
      jid, folder, owner_user_id, name, agent_profile_id, status, execution_mode, is_home,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    folder,
    ownerUserId,
    fields.name,
    fields.agent_profile_id ?? null,
    'active',
    execution.mode,
    fields.is_home ? 1 : 0,
    now,
    now,
  );
  return getWorkspaceById(db, jid)!;
}

export function updateWorkspace(
  db: Db,
  ownerUserId: string,
  jid: string,
  fields: { name?: string; agent_profile_id?: string | null; execution_mode?: ExecutionMode },
): { ok: boolean; reason?: 'not_found' | 'home_immutable' | 'invalid_profile' | 'host_forbidden' } {
  const row = getOwnedWorkspace(db, ownerUserId, jid);
  if (!row) return { ok: false, reason: 'not_found' };
  const sets: string[] = [];
  const params: unknown[] = [];
  if (fields.name !== undefined) {
    sets.push('name = ?');
    params.push(fields.name);
  }
  if (fields.agent_profile_id !== undefined) {
    const profile = fields.agent_profile_id
      ? getOwnedAgentProfile(db, ownerUserId, fields.agent_profile_id)
      : undefined;
    if (fields.agent_profile_id && !profile) {
      return { ok: false, reason: 'invalid_profile' };
    }
    if (row.is_home === 1) return { ok: false, reason: 'home_immutable' };
    sets.push('agent_profile_id = ?');
    params.push(fields.agent_profile_id);
  }
  if (fields.execution_mode !== undefined) {
    const execution = resolveRequestedExecutionMode(db, ownerUserId, fields.execution_mode);
    if (!execution.ok) return { ok: false, reason: execution.reason };
    if (row.is_home === 1 && fields.execution_mode !== row.execution_mode) return { ok: false, reason: 'home_immutable' };
    sets.push('execution_mode = ?');
    params.push(execution.mode);
  }
  if (sets.length === 0) return { ok: true };
  params.push(new Date().toISOString(), jid, ownerUserId);
  db.prepare(
    `UPDATE workspaces SET ${sets.join(', ')}, updated_at = ? WHERE jid = ? AND owner_user_id = ?`,
  ).run(...params);
  return { ok: true };
}

export interface DeleteWorkspaceResult {
  ok: boolean;
  reason?: 'not_found' | 'home';
}

export function deleteWorkspace(
  db: Db,
  ownerUserId: string,
  jid: string,
): DeleteWorkspaceResult {
  const row = getOwnedWorkspace(db, ownerUserId, jid);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.is_home === 1) return { ok: false, reason: 'home' };
  db.transaction(() => {
    db.prepare('DELETE FROM agent_channel_mounts WHERE workspace_jid = ?').run(jid);
    db.prepare('DELETE FROM channel_mounts WHERE workspace_jid = ?').run(jid);
    db.prepare('DELETE FROM im_context_bindings WHERE workspace_jid = ?').run(jid);
    db.prepare('DELETE FROM runtime_sessions WHERE workspace_jid = ?').run(jid);
    db.prepare('DELETE FROM workspaces WHERE jid = ?').run(jid);
  })();
  return { ok: true };
}

export function toWorkspacePublic(row: WorkspaceRow) {
  return {
    jid: row.jid,
    folder: row.folder,
    name: row.name,
    agent_profile_id: row.agent_profile_id,
    status: row.status,
    execution_mode: row.execution_mode,
    is_home: row.is_home === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
