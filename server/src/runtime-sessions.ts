import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { getOwnedAgentProfile } from './agent-profiles.js';
import { getOwnedWorkspace } from './workspaces.js';

export type Db = Database.Database;

export interface RuntimeSessionRow {
  id: string;
  workspace_jid: string;
  name: string;
  agent_profile_id: string | null;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export function generateRuntimeSessionId(): string {
  return `rs_${crypto.randomUUID()}`;
}

export function getRuntimeSessionById(
  db: Db,
  id: string,
): RuntimeSessionRow | undefined {
  return db
    .prepare('SELECT * FROM runtime_sessions WHERE id = ?')
    .get(id) as RuntimeSessionRow | undefined;
}

export function listRuntimeSessions(
  db: Db,
  ownerUserId: string,
  workspaceJid: string,
): RuntimeSessionRow[] | undefined {
  if (!getOwnedWorkspace(db, ownerUserId, workspaceJid)) return undefined;
  return db
    .prepare(
      'SELECT * FROM runtime_sessions WHERE workspace_jid = ? ORDER BY updated_at DESC',
    )
    .all(workspaceJid) as RuntimeSessionRow[];
}

export function createRuntimeSession(
  db: Db,
  ownerUserId: string,
  workspaceJid: string,
  fields: { name?: string; agent_profile_id?: string | null },
): { ok: boolean; reason?: 'workspace_not_found' | 'invalid_profile' } {
  const ws = getOwnedWorkspace(db, ownerUserId, workspaceJid);
  if (!ws) return { ok: false, reason: 'workspace_not_found' };
  if (fields.agent_profile_id) {
    const profile = getOwnedAgentProfile(
      db,
      ownerUserId,
      fields.agent_profile_id,
    );
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
  return { ok: true };
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
  };
}
