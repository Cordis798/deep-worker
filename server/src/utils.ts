import type { AuthUser, UserRole, UserStatus } from './types.js';

export function clientIp(c: {
  req: { header(key: string): string | undefined };
}): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return '127.0.0.1';
}

export interface UserRecord {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: UserRole;
  status: UserStatus;
  permissions: string;
  must_change_password: number;
  created_at: string;
  updated_at: string;
}

export function toAuthUser(row: UserRecord): AuthUser {
  let permissions: AuthUser['permissions'] = [];
  try {
    permissions = JSON.parse(row.permissions || '[]');
  } catch {
    permissions = [];
  }
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    status: row.status,
    display_name: row.display_name,
    permissions,
    must_change_password: row.must_change_password === 1,
  };
}

export function toUserPublic(row: UserRecord): Record<string, unknown> {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    status: row.status,
    permissions: JSON.parse(row.permissions || '[]'),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
