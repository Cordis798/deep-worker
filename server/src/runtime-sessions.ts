import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { createAgentProfile, getAgentProfileById, getOwnedAgentProfile } from './agent-profiles.js';
import { canWorkspaceAction, getWorkspaceAccess } from './workspace-acl.js';
import { getOwnedWorkspace, getWorkspaceById } from './workspaces.js';

export type Db = Database.Database;

export interface RuntimeSessionRow {
  id: string;
  workspace_jid: string;
  name: string;
  agent_profile_id: string | null;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
  context_status?: 'new' | 'restored' | 'reset_required';
  context_generation?: number;
  source_session_id?: string | null;
  source_snapshot_hash?: string | null;
}

export function generateRuntimeSessionId(): string {
  return `rs_${crypto.randomUUID()}`;
}

export function getRuntimeSessionById(db: Db, id: string): RuntimeSessionRow | undefined {
  return db.prepare('SELECT * FROM runtime_sessions WHERE id = ?').get(id) as
    RuntimeSessionRow | undefined;
}

export function getOwnedRuntimeSession(
  db: Db,
  ownerUserId: string,
  workspaceJid: string,
  id: string,
): RuntimeSessionRow | undefined {
  return db
    .prepare(
      `SELECT r.* FROM runtime_sessions r
       JOIN workspaces w ON w.jid = r.workspace_jid
       WHERE r.id = ? AND r.workspace_jid = ? AND w.owner_user_id = ?`,
    )
    .get(id, workspaceJid, ownerUserId) as RuntimeSessionRow | undefined;
}

/** 返回工作区成员可见的会话；成员资格在每次读取时重新校验。 */
export function getAccessibleRuntimeSession(
  db: Db,
  actorUserId: string,
  workspaceJid: string,
  id: string,
): RuntimeSessionRow | undefined {
  if (!getWorkspaceAccess(db, actorUserId, workspaceJid)) return undefined;
  return db
    .prepare(
      `SELECT r.* FROM runtime_sessions r
       WHERE r.id = ? AND r.workspace_jid = ?`,
    )
    .get(id, workspaceJid) as RuntimeSessionRow | undefined;
}

export function listRuntimeSessions(
  db: Db,
  ownerUserId: string,
  workspaceJid: string,
): RuntimeSessionRow[] | undefined {
  if (!getOwnedWorkspace(db, ownerUserId, workspaceJid)) return undefined;
  return db
    .prepare('SELECT * FROM runtime_sessions WHERE workspace_jid = ? ORDER BY updated_at DESC')
    .all(workspaceJid) as RuntimeSessionRow[];
}

export function listAccessibleRuntimeSessions(
  db: Db,
  actorUserId: string,
  workspaceJid: string,
): RuntimeSessionRow[] | undefined {
  if (!getWorkspaceAccess(db, actorUserId, workspaceJid)) return undefined;
  return db
    .prepare('SELECT * FROM runtime_sessions WHERE workspace_jid = ? ORDER BY updated_at DESC')
    .all(workspaceJid) as RuntimeSessionRow[];
}

function canUseProfile(
  db: Db,
  actorUserId: string,
  workspaceJid: string,
  profileId: string,
): boolean {
  const profile = getAgentProfileById(db, profileId);
  if (!profile || profile.status !== 'active') return false;
  const workspace = getWorkspaceById(db, workspaceJid);
  if (!workspace) return false;
  if (profile.owner_user_id === actorUserId) return true;
  if (workspace.agent_profile_id === profileId && !!getWorkspaceAccess(db, actorUserId, workspaceJid)) return true;
  return !!db.prepare(
    `SELECT 1 FROM workspace_agent_bindings b
     JOIN workspace_members m ON m.workspace_jid = b.workspace_jid
     WHERE b.workspace_jid = ? AND b.agent_profile_id = ?
       AND b.enabled = 1 AND m.user_id = ? AND m.status = 'active'`,
  ).get(workspaceJid, profileId, actorUserId);
}

export function createAccessibleRuntimeSession(
  db: Db,
  actorUserId: string,
  workspaceJid: string,
  fields: { name?: string; agent_profile_id?: string | null },
): { ok: boolean; id?: string; reason?: 'workspace_not_found' | 'forbidden' | 'invalid_profile' } {
  if (!canWorkspaceAction(db, actorUserId, workspaceJid, 'converse')) {
    return { ok: false, reason: 'workspace_not_found' };
  }
  const workspace = getWorkspaceById(db, workspaceJid);
  if (!workspace) return { ok: false, reason: 'workspace_not_found' };
  const profileId = fields.agent_profile_id ?? workspace.agent_profile_id;
  if (profileId && !canUseProfile(db, actorUserId, workspaceJid, profileId)) {
    return { ok: false, reason: 'invalid_profile' };
  }
  const now = new Date().toISOString();
  const id = generateRuntimeSessionId();
  db.prepare(
    `INSERT INTO runtime_sessions (
      id, workspace_jid, name, agent_profile_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, workspaceJid, fields.name ?? 'New session', profileId ?? null, 'active', now, now);
  return { ok: true, id };
}

export function updateAccessibleRuntimeSession(
  db: Db,
  actorUserId: string,
  workspaceJid: string,
  id: string,
  fields: { name?: string; status?: 'active' | 'archived' },
): { ok: boolean; reason?: 'not_found' } {
  if (!canWorkspaceAction(db, actorUserId, workspaceJid, 'manage')) return { ok: false, reason: 'not_found' };
  const sets: string[] = [];
  const params: unknown[] = [];
  if (fields.name !== undefined) { sets.push('name = ?'); params.push(fields.name); }
  if (fields.status !== undefined) { sets.push('status = ?'); params.push(fields.status); }
  if (sets.length === 0) return { ok: true };
  params.push(new Date().toISOString(), workspaceJid, id);
  const result = db
    .prepare(`UPDATE runtime_sessions SET ${sets.join(', ')}, updated_at = ? WHERE workspace_jid = ? AND id = ?`)
    .run(...params);
  return result.changes > 0 ? { ok: true } : { ok: false, reason: 'not_found' };
}

export function archiveAccessibleRuntimeSession(
  db: Db,
  actorUserId: string,
  workspaceJid: string,
  id: string,
): { ok: boolean; reason?: 'not_found' } {
  return updateAccessibleRuntimeSession(db, actorUserId, workspaceJid, id, { status: 'archived' });
}

export function copyRuntimeSessionToPersonalWorkspace(
  db: Db,
  actorUserId: string,
  workspaceJid: string,
  id: string,
): { ok: boolean; workspaceJid?: string; sessionId?: string; reason?: 'not_found' | 'forbidden' } {
  if (!canWorkspaceAction(db, actorUserId, workspaceJid, 'copy')) return { ok: false, reason: 'not_found' };
  const source = getAccessibleRuntimeSession(db, actorUserId, workspaceJid, id);
  if (!source) return { ok: false, reason: 'not_found' };
  const sourceProfile = source.agent_profile_id ? getAgentProfileById(db, source.agent_profile_id) : undefined;
  const now = new Date().toISOString();
  const copy = db.transaction(() => {
    const profile = sourceProfile
      ? createAgentProfile(db, actorUserId, {
        name: `${sourceProfile.name}（副本）`,
        identity_prompt: sourceProfile.identity_prompt,
        soul_prompt: sourceProfile.soul_prompt,
        agents_prompt: sourceProfile.agents_prompt,
        tools_prompt: sourceProfile.tools_prompt,
        prompt_mode: sourceProfile.prompt_mode as 'append' | 'replace',
      })
      : undefined;
    const workspaceId = `web:${crypto.randomUUID()}`;
    const workspaceFolder = workspaceId.replace(/[^a-zA-Z0-9_.-]/g, '_');
    db.prepare(
      `INSERT INTO workspaces (
        jid, folder, owner_user_id, name, agent_profile_id, status, execution_mode,
        is_home, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', 'container', 0, ?, ?)`,
    ).run(workspaceId, workspaceFolder, actorUserId, `${source.name}（副本）`, profile?.id ?? null, now, now);
    db.prepare(
      `INSERT INTO workspace_members (
        workspace_jid, user_id, role, status, invited_by, created_at, updated_at
      ) VALUES (?, ?, 'workspace_admin', 'active', ?, ?, ?)`,
    ).run(workspaceId, actorUserId, actorUserId, now, now);
    const sessionId = generateRuntimeSessionId();
    db.prepare(
      `INSERT INTO runtime_sessions (
        id, workspace_jid, name, agent_profile_id, status, created_at, updated_at,
        context_status, context_generation, source_session_id, source_snapshot_hash
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, 'new', 1, ?, ?)`,
    ).run(sessionId, workspaceId, `${source.name}（副本）`, profile?.id ?? null, now, now, source.id, source.source_snapshot_hash ?? null);
    return { workspaceId, sessionId };
  })();
  return { ok: true, workspaceJid: copy.workspaceId, sessionId: copy.sessionId };
}

export function createRuntimeSession(
  db: Db,
  ownerUserId: string,
  workspaceJid: string,
  fields: { name?: string; agent_profile_id?: string | null },
): { ok: boolean; id?: string; reason?: 'workspace_not_found' | 'invalid_profile' } {
  const ws = getOwnedWorkspace(db, ownerUserId, workspaceJid);
  if (!ws) return { ok: false, reason: 'workspace_not_found' };
  if (fields.agent_profile_id) {
    const profile = getOwnedAgentProfile(db, ownerUserId, fields.agent_profile_id);
    if (!profile) return { ok: false, reason: 'invalid_profile' };
  }
  const now = new Date().toISOString();
  const id = generateRuntimeSessionId();
  db.prepare(
    `INSERT INTO runtime_sessions (
      id, workspace_jid, name, agent_profile_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    workspaceJid,
    fields.name ?? 'New session',
    fields.agent_profile_id ?? ws.agent_profile_id ?? null,
    'active',
    now,
    now,
  );
  return { ok: true, id };
}

export function updateRuntimeSession(
  db: Db,
  ownerUserId: string,
  workspaceJid: string,
  id: string,
  fields: { name?: string; status?: 'active' | 'archived' },
): { ok: boolean; reason?: 'not_found' } {
  const ws = getOwnedWorkspace(db, ownerUserId, workspaceJid);
  if (!ws) return { ok: false, reason: 'not_found' };
  const sets: string[] = [];
  const params: unknown[] = [];
  if (fields.name !== undefined) {
    sets.push('name = ?');
    params.push(fields.name);
  }
  if (fields.status !== undefined) {
    sets.push('status = ?');
    params.push(fields.status);
  }
  if (sets.length === 0) return { ok: true };
  params.push(new Date().toISOString(), workspaceJid, id);
  const result = db
    .prepare(
      `UPDATE runtime_sessions SET ${sets.join(', ')}, updated_at = ? WHERE workspace_jid = ? AND id = ?`,
    )
    .run(...params);
  return result.changes > 0 ? { ok: true } : { ok: false, reason: 'not_found' };
}

export interface ArchiveSessionResult {
  ok: boolean;
  reason?: 'not_found';
}

export function archiveRuntimeSession(
  db: Db,
  ownerUserId: string,
  workspaceJid: string,
  id: string,
): ArchiveSessionResult {
  const ws = getOwnedWorkspace(db, ownerUserId, workspaceJid);
  if (!ws) return { ok: false, reason: 'not_found' };
  const result = db
    .prepare(
      "UPDATE runtime_sessions SET status = 'archived', updated_at = ? WHERE workspace_jid = ? AND id = ?",
    )
    .run(new Date().toISOString(), workspaceJid, id);
  return result.changes > 0 ? { ok: true } : { ok: false, reason: 'not_found' };
}

export function toRuntimeSessionPublic(row: RuntimeSessionRow) {
  return {
    id: row.id,
    workspace_jid: row.workspace_jid,
    name: row.name,
    agent_profile_id: row.agent_profile_id,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.context_status ? { context_status: row.context_status } : {}),
    ...(row.context_generation ? { context_generation: row.context_generation } : {}),
    ...(row.source_session_id ? { source_session_id: row.source_session_id } : {}),
    ...(row.source_snapshot_hash ? { source_snapshot_hash: row.source_snapshot_hash } : {}),
  };
}
