import type Database from 'better-sqlite3';
import type { WorkspaceRow } from './workspaces.js';

export type WorkspaceRole = 'workspace_admin' | 'member' | 'viewer';
export type WorkspaceAction = 'view' | 'converse' | 'manage' | 'copy';

export interface WorkspaceAccessContext {
  actorUserId: string;
  workspaceJid: string;
  workspaceOwnerUserId: string;
  credentialPrincipalId: string;
  billingPrincipalId: string;
  role: WorkspaceRole;
}

export interface WorkspaceMemberRow {
  workspace_jid: string;
  user_id: string;
  username: string;
  display_name: string;
  role: WorkspaceRole;
  job_role: 'general' | 'engineering' | 'operations' | 'sales';
  capability_package: string;
  status: 'active' | 'revoked';
  invited_by: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

export function getWorkspaceAccess(
  db: Database.Database,
  actorUserId: string,
  workspaceJid: string,
): WorkspaceAccessContext | undefined {
  const row = db
    .prepare(
      `SELECT w.owner_user_id, m.role
       FROM workspaces w
       JOIN workspace_members m ON m.workspace_jid = w.jid
         AND m.user_id = ? AND m.status = 'active'
       WHERE w.jid = ? AND w.status = 'active'`,
    )
    .get(actorUserId, workspaceJid) as
    | { owner_user_id: string | null; role: WorkspaceRole }
    | undefined;
  if (!row?.owner_user_id) {
    // Compatibility for workspaces created before membership backfill. New writes
    // always create an explicit membership row, while legacy owners retain access.
    const legacyOwner = db
      .prepare(
        `SELECT owner_user_id FROM workspaces
         WHERE jid = ? AND status = 'active' AND owner_user_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM workspace_members WHERE workspace_jid = ?
           )`,
      )
      .get(workspaceJid, actorUserId, workspaceJid) as { owner_user_id: string } | undefined;
    if (!legacyOwner) return undefined;
    return {
      actorUserId,
      workspaceJid,
      workspaceOwnerUserId: legacyOwner.owner_user_id,
      credentialPrincipalId: legacyOwner.owner_user_id,
      billingPrincipalId: legacyOwner.owner_user_id,
      role: 'workspace_admin',
    };
  }
  return {
    actorUserId,
    workspaceJid,
    workspaceOwnerUserId: row.owner_user_id,
    credentialPrincipalId: row.owner_user_id,
    billingPrincipalId: row.owner_user_id,
    role: row.role,
  };
}

const allowedRoles: Record<WorkspaceAction, WorkspaceRole[]> = {
  view: ['workspace_admin', 'member', 'viewer'],
  converse: ['workspace_admin', 'member'],
  manage: ['workspace_admin'],
  copy: ['workspace_admin', 'member'],
};

export function canWorkspaceAction(
  db: Database.Database,
  actorUserId: string,
  workspaceJid: string,
  action: WorkspaceAction,
): boolean {
  const access = getWorkspaceAccess(db, actorUserId, workspaceJid);
  return !!access && allowedRoles[action].includes(access.role);
}

export function listAccessibleWorkspaces(
  db: Database.Database,
  actorUserId: string,
): WorkspaceRow[] {
  return db
    .prepare(
      `SELECT w.* FROM workspaces w
       JOIN workspace_members m ON m.workspace_jid = w.jid
       WHERE m.user_id = ? AND m.status = 'active' AND w.status = 'active'
       ORDER BY w.is_home DESC, w.created_at ASC`,
    )
    .all(actorUserId) as WorkspaceRow[];
}

export function listWorkspaceMembers(
  db: Database.Database,
  actorUserId: string,
  workspaceJid: string,
): WorkspaceMemberRow[] | undefined {
  if (!canWorkspaceAction(db, actorUserId, workspaceJid, 'manage')) return undefined;
  return db
    .prepare(
      `SELECT m.*, u.username, u.display_name
       FROM workspace_members m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_jid = ? ORDER BY m.status ASC, m.role ASC, u.username ASC`,
    )
    .all(workspaceJid) as WorkspaceMemberRow[];
}

export function addWorkspaceMember(
  db: Database.Database,
  actorUserId: string,
  workspaceJid: string,
  userId: string,
  role: Exclude<WorkspaceRole, 'workspace_admin'>,
  options: { jobRole?: WorkspaceMemberRow['job_role']; capabilityPackage?: string } = {},
): { ok: boolean; reason?: 'forbidden' | 'workspace_not_found' | 'user_not_found' } {
  if (!canWorkspaceAction(db, actorUserId, workspaceJid, 'manage')) {
    return { ok: false, reason: 'forbidden' };
  }
  const user = db.prepare("SELECT id FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(userId);
  if (!user) return { ok: false, reason: 'user_not_found' };
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace_members (
      workspace_jid, user_id, role, job_role, capability_package, status,
      invited_by, created_at, updated_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)
    ON CONFLICT(workspace_jid, user_id) DO UPDATE SET
      role = excluded.role, job_role = excluded.job_role,
      capability_package = excluded.capability_package, status = 'active',
      invited_by = excluded.invited_by, updated_at = excluded.updated_at, revoked_at = NULL`,
  ).run(
    workspaceJid,
    userId,
    role,
    options.jobRole ?? 'general',
    options.capabilityPackage ?? options.jobRole ?? 'general',
    actorUserId,
    now,
    now,
  );
  return { ok: true };
}

export function revokeWorkspaceMember(
  db: Database.Database,
  actorUserId: string,
  workspaceJid: string,
  userId: string,
): { ok: boolean; reason?: 'forbidden' | 'not_found' | 'last_admin' } {
  if (!canWorkspaceAction(db, actorUserId, workspaceJid, 'manage')) {
    return { ok: false, reason: 'forbidden' };
  }
  const target = db
    .prepare('SELECT role, status FROM workspace_members WHERE workspace_jid = ? AND user_id = ?')
    .get(workspaceJid, userId) as { role: WorkspaceRole; status: string } | undefined;
  if (!target || target.status !== 'active') return { ok: false, reason: 'not_found' };
  if (target.role === 'workspace_admin') {
    const count = db
      .prepare("SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_jid = ? AND role = 'workspace_admin' AND status = 'active'")
      .get(workspaceJid) as { count: number };
    if (count.count <= 1) return { ok: false, reason: 'last_admin' };
  }
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE workspace_members SET status = 'revoked', revoked_at = ?, updated_at = ?
     WHERE workspace_jid = ? AND user_id = ?`,
  ).run(now, now, workspaceJid, userId);
  return { ok: true };
}
