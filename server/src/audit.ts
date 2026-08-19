import type Database from 'better-sqlite3';

export type Db = Database.Database;

export function insertAuthAudit(
  db: Db,
  row: {
    event_type: string;
    username: string;
    actor_username?: string | null;
    ip_address?: string | null;
    user_agent?: string | null;
    details?: unknown;
  },
): void {
  db.prepare(
    `INSERT INTO auth_audit_log (event_type, username, actor_username, ip_address, user_agent, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    row.event_type,
    row.username,
    row.actor_username ?? null,
    row.ip_address ?? null,
    row.user_agent ?? null,
    row.details === undefined ? null : JSON.stringify(row.details),
  );
}

export function queryAuditLogs(
  db: Db,
  options: { limit?: number; offset?: number } = {},
): Array<Record<string, unknown>> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);
  return db
    .prepare(
      'SELECT * FROM auth_audit_log ORDER BY id DESC LIMIT ? OFFSET ?',
    )
    .all(limit, offset) as Array<Record<string, unknown>>;
}
