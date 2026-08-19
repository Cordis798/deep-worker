import { createMiddleware } from 'hono/factory';
import {
  SESSION_COOKIE_NAME_PLAIN,
  SESSION_COOKIE_NAME_SECURE,
} from '../config.js';
import { verifySessionToken } from '../auth.js';
import { getSessionWithUser, deleteUserSession } from '../sessions.js';
import type { Db } from '../sessions.js';
import { hasPermission } from '../permissions.js';
import { isSessionExpired } from '../auth.js';
import { logger } from '../logger.js';
import type { AppVariables, Permission } from '../types.js';

export function getAllCookieValues(
  cookieHeader: string | undefined,
  name: string,
): string[] {
  if (!cookieHeader) return [];
  const values: string[] = [];
  const prefix = `${name}=`;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      values.push(trimmed.slice(prefix.length));
    }
  }
  return values;
}

export function tryVerifyAny(
  values: string[],
): { token: string; legacy: boolean } | null {
  for (const value of values) {
    const verified = verifySessionToken(value);
    if (verified) return verified;
  }
  return null;
}

export const authMiddleware = (db: Db) =>
  createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
    const cookieHeader = c.req.header('cookie');
    let allValues = getAllCookieValues(cookieHeader, SESSION_COOKIE_NAME_SECURE);
    if (allValues.length === 0) {
      allValues = getAllCookieValues(cookieHeader, SESSION_COOKIE_NAME_PLAIN);
    }
    if (allValues.length === 0) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const result = tryVerifyAny(allValues);
    if (!result) return c.json({ error: 'Unauthorized' }, 401);

    const { token } = result;
    const session = getSessionWithUser(db, token);
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    if (isSessionExpired(session.expires_at)) {
      deleteUserSession(db, token);
      return c.json({ error: 'Session expired' }, 401);
    }
    if (session.status === 'disabled') {
      return c.json({ error: 'Account disabled' }, 403);
    }
    if (session.status === 'deleted') {
      return c.json({ error: 'Account deleted' }, 403);
    }

    c.set('user', {
      id: session.id,
      username: session.username,
      role: session.role,
      status: session.status,
      display_name: session.display_name,
      permissions: session.permissions,
      must_change_password: session.must_change_password,
    });
    c.set('sessionId', token);

    const path = c.req.path;
    const canBypassForcedChange =
      path === '/api/auth/me' ||
      path === '/api/auth/password' ||
      path === '/api/auth/logout' ||
      path.startsWith('/api/auth/sessions');
    const user = c.get('user');
    if (user?.must_change_password && !canBypassForcedChange) {
      return c.json(
        { error: 'Password change required', code: 'PASSWORD_CHANGE_REQUIRED' },
        403,
      );
    }

    await next();
  });

export const requirePermission = (permission: Permission) =>
  createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
    const user = c.get('user');
    if (!user || !hasPermission(user, permission)) {
      return c.json({ error: `Forbidden: ${permission} required` }, 403);
    }
    await next();
  });

export const requireAnyPermission = (permissions: Permission[]) =>
  createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
    const user = c.get('user');
    const ok =
      !!user && permissions.some((permission) => hasPermission(user, permission));
    if (!ok) {
      return c.json(
        { error: `Forbidden: one of [${permissions.join(', ')}] required` },
        403,
      );
    }
    await next();
  });

export const adminRoleMiddleware = (db: Db) =>
  authMiddleware(db);

export const systemConfigMiddleware = (db: Db) =>
  requirePermission('manage_system_config');

export const usersManageMiddleware = (db: Db) =>
  requirePermission('manage_users');

export const inviteManageMiddleware = (db: Db) =>
  requirePermission('manage_invites');

export const auditViewMiddleware = (db: Db) =>
  requirePermission('view_audit_log');

export { logger };
