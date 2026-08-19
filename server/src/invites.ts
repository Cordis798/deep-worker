import type Database from 'better-sqlite3';
import type { Permission, UserRole } from './types.js';

export type Db = Database.Database;

export interface InviteRow {
  code: string;
  created_by: string;
  role: UserRole;
  permissions: string;
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  created_at: string;
}

export function createInvite(
  db: Db,
  invite: {
    code: string;
    created_by: string;
    role?: UserRole;
    permissions?: Permission[];
    max_uses?: number;
    expires_at?: string;
    created_at: string;
  },
): void {
  db.prepare(
    `INSERT INTO invite_codes (code, created_by, role, permissions, max_uses, used_count, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    invite.code,
    invite.created_by,
    invite.role ?? 'member',
    JSON.stringify(invite.permissions ?? []),
    invite.max_uses ?? 1,
    invite.expires_at ?? null,
    invite.created_at,
  );
}

export function listInvites(db: Db): InviteRow[] {
  return db
    .prepare('SELECT * FROM invite_codes ORDER BY created_at DESC')
    .all() as InviteRow[];
}

export function getInvite(db: Db, code: string): InviteRow | undefined {
  return db
    .prepare('SELECT * FROM invite_codes WHERE code = ?')
    .get(code) as InviteRow | undefined;
}

export function consumeInvite(
  db: Db,
  code: string,
): { ok: boolean } & Partial<Pick<InviteRow, 'role' | 'permissions'>> {
  const row = getInvite(db, code);
  if (!row) return { ok: false };
  const expired = row.expires_at ? new Date(row.expires_at).getTime() < Date.now() : false;
  if (expired || row.used_count >= row.max_uses) return { ok: false };
  db.prepare('UPDATE invite_codes SET used_count = used_count + 1 WHERE code = ?').run(code);
  return { ok: true, role: row.role, permissions: row.permissions };
}

export function revokeInvite(db: Db, code: string): boolean {
  const result = db.prepare('DELETE FROM invite_codes WHERE code = ?').run(code);
  return result.changes > 0;
}
