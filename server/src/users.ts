import type Database from 'better-sqlite3';
import type { Permission, UserRole, UserStatus } from './types.js';
import type { UserRecord } from './utils.js';

export type Db = Database.Database;

export function countUsers(db: Db): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM users WHERE deleted_at IS NULL')
    .get() as { count: number };
  return row.count;
}

export function getUserByUsername(db: Db, username: string): UserRecord | undefined {
  return db
    .prepare('SELECT * FROM users WHERE username = ? AND deleted_at IS NULL')
    .get(username) as UserRecord | undefined;
}

export function getUserById(db: Db, id: string): UserRecord | undefined {
  return db
    .prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL')
    .get(id) as UserRecord | undefined;
}

/** Include deleted users (restore paths need to locate soft-deleted rows). */
export function findUser(db: Db, id: string): UserRecord | undefined {
  return db
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(id) as UserRecord | undefined;
}

export interface CreateUserFields {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  role?: UserRole;
  status?: UserStatus;
  must_change_password?: boolean;
  notes?: string;
  created_at: string;
  updated_at: string;
}

export function createInitialAdminUser(
  db: Db,
  fields: CreateUserFields,
): { ok: boolean; reason?: 'already_initialized' | 'username_taken' } {
  if (countUsers(db) > 0) return { ok: false, reason: 'already_initialized' };
  return createUser(db, fields);
}

export function createUser(
  db: Db,
  fields: CreateUserFields,
): { ok: boolean; reason?: 'username_taken' } {
  if (getUserByUsername(db, fields.username)) {
    return { ok: false, reason: 'username_taken' };
  }
  db.prepare(
    `INSERT INTO users (
      id, username, password_hash, display_name, role, status, permissions,
      must_change_password, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fields.id,
    fields.username,
    fields.password_hash,
    fields.display_name,
    fields.role ?? 'member',
    fields.status ?? 'active',
    JSON.stringify([]),
    fields.must_change_password ? 1 : 0,
    fields.notes ?? null,
    fields.created_at,
    fields.updated_at,
  );
  return { ok: true };
}

export interface UserListFilter {
  role?: UserRole | 'all';
  status?: UserStatus | 'all';
}

export function listUsers(db: Db, filter: UserListFilter = {}): UserRecord[] {
  const clauses = ['deleted_at IS NULL'];
  const params: unknown[] = [];
  if (filter.role && filter.role !== 'all') {
    clauses.push('role = ?');
    params.push(filter.role);
  }
  if (filter.status && filter.status !== 'all') {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  return db
    .prepare(`SELECT * FROM users WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC`)
    .all(...params) as UserRecord[];
}

export function updateUserFields(
  db: Db,
  id: string,
  fields: Record<string, unknown>,
): boolean {
  const keys = Object.keys(fields);
  if (keys.length === 0) return false;
  const sets = keys.map((key) => `${key} = ?`).join(', ');
  const result = db
    .prepare(`UPDATE users SET ${sets}, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`)
    .run(...keys.map((key) => fields[key]), id);
  return result.changes > 0;
}

export function setUserRole(
  db: Db,
  id: string,
  role: UserRole,
  permissions: Permission[],
): boolean {
  return updateUserFields(db, id, {
    role,
    permissions: JSON.stringify(permissions),
    updated_at: new Date().toISOString(),
  });
}

export function disableUser(db: Db, id: string, reason: string | null): boolean {
  return updateUserFields(db, id, {
    status: 'disabled',
    disable_reason: reason,
  });
}

export function enableUser(db: Db, id: string): boolean {
  return updateUserFields(db, id, { status: 'active', disable_reason: null });
}

export function softDeleteUser(db: Db, id: string): boolean {
  return updateUserFields(db, id, {
    status: 'deleted',
    deleted_at: new Date().toISOString(),
  });
}

export function restoreUser(db: Db, id: string): boolean {
  return updateUserFields(db, id, {
    status: 'active',
    delete_reason: null,
    deleted_at: null,
  });
}

export function resetUserPassword(
  db: Db,
  id: string,
  passwordHash: string,
  mustChangePassword: boolean,
): boolean {
  return updateUserFields(db, id, {
    password_hash: passwordHash,
    must_change_password: mustChangePassword ? 1 : 0,
  });
}
