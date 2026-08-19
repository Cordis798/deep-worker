import type Database from 'better-sqlite3';
import type { AuthUser } from './types.js';

export type Db = Database.Database;

export interface SessionWithUser extends AuthUser {
  sessionId: string;
  expires_at: string;
  created_at: string;
  ip_address: string | null;
  user_agent: string | null;
}

export function createUserSession(
  db: Db,
  session: {
    id: string;
    user_id: string;
    ip_address?: string | null;
    user_agent?: string | null;
    created_at: string;
    expires_at: string;
    last_active_at: string;
  },
): void {
  db.prepare(
    `INSERT INTO user_sessions (id, user_id, ip_address, user_agent, created_at, expires_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    session.user_id,
    session.ip_address ?? null,
    session.user_agent ?? null,
    session.created_at,
    session.expires_at,
    session.last_active_at,
  );
}

export function getSessionWithUser(
  db: Db,
  token: string,
): SessionWithUser | null {
  const row = db
    .prepare(
      `SELECT s.id AS sessionId, s.user_id AS userId, s.expires_at, s.created_at,
              s.ip_address, s.user_agent,
              u.username, u.role, u.status, u.display_name, u.permissions,
              u.must_change_password
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND u.deleted_at IS NULL`,
    )
    .get(token) as
    | {
        sessionId: string;
        userId: string;
        expires_at: string;
        created_at: string;
        ip_address: string | null;
        user_agent: string | null;
        username: string;
        role: 'admin' | 'member';
        status: 'active' | 'disabled' | 'deleted';
        display_name: string;
        permissions: string;
        must_change_password: number;
      }
    | undefined;
  if (!row) return null;
  return {
    ...row,
    id: row.userId,
    permissions: JSON.parse(row.permissions || '[]'),
    must_change_password: row.must_change_password === 1,
  };
}

export function deleteUserSession(db: Db, token: string): void {
  db.prepare('DELETE FROM user_sessions WHERE id = ?').run(token);
}

export function listUserSessions(
  db: Db,
  userId: string,
): Array<{ id: string; created_at: string; expires_at: string; last_active_at: string }> {
  return db
    .prepare(
      'SELECT id, created_at, expires_at, last_active_at FROM user_sessions WHERE user_id = ? ORDER BY created_at DESC',
    )
    .all(userId) as Array<{
    id: string;
    created_at: string;
    expires_at: string;
    last_active_at: string;
  }>;
}

export function deleteOwnSession(db: Db, userId: string, sessionId: string): boolean {
  const result = db
    .prepare('DELETE FROM user_sessions WHERE id = ? AND user_id = ?')
    .run(sessionId, userId);
  return result.changes > 0;
}

export function revokeAllUserSessions(db: Db, userId: string): void {
  db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
}
