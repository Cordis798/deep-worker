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
  if (!row?.owner_user_id) return undefined;
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
