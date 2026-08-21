import type Database from 'better-sqlite3';
import { canExecuteOnHost, HOST_EXECUTION_FORBIDDEN_ERROR } from './host-execution-policy.js';
import { getUserById } from './users.js';
import type { WorkspaceRow } from './workspaces.js';

export type ExecutionMode = 'host' | 'container';

export function effectiveExecutionMode(db: Database.Database, workspace: Pick<WorkspaceRow, 'execution_mode' | 'owner_user_id'>): ExecutionMode {
  if (workspace.execution_mode !== 'host') return 'container';
  const owner = workspace.owner_user_id ? getUserById(db, workspace.owner_user_id) : undefined;
  return canExecuteOnHost(owner) ? 'host' : 'container';
}

export function resolveRequestedExecutionMode(
  db: Database.Database,
  ownerUserId: string,
  requested?: ExecutionMode,
): { ok: true; mode: ExecutionMode } | { ok: false; reason: 'host_forbidden' } {
  const owner = getUserById(db, ownerUserId);
  const mode = requested ?? (canExecuteOnHost(owner) ? 'host' : 'container');
  if (mode === 'host' && !canExecuteOnHost(owner)) return { ok: false, reason: 'host_forbidden' };
  return { ok: true, mode };
}

export function assertHostExecutionAllowed(db: Database.Database, ownerUserId: string): void {
  if (!canExecuteOnHost(getUserById(db, ownerUserId))) throw new Error(HOST_EXECUTION_FORBIDDEN_ERROR);
}
