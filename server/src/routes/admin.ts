import { Hono } from 'hono';
import {
  generateInviteCode,
  generateUserId,
  hashPassword,
  validatePassword,
  validateUsername,
} from '../auth.js';
import { insertAuthAudit, queryAuditLogs } from '../audit.js';
import { createInvite, listInvites, revokeInvite } from '../invites.js';
import {
  auditViewMiddleware,
  authMiddleware,
  inviteManageMiddleware,
  usersManageMiddleware,
} from '../middleware/auth.js';
import { getDefaultPermissions } from '../permissions.js';
import { revokeAllUserSessions } from '../sessions.js';
import { clientIp, toUserPublic } from '../utils.js';
import {
  createUser,
  disableUser,
  enableUser,
  findUser,
  getUserById,
  listUsers,
  resetUserPassword,
  restoreUser,
  setUserRole,
  softDeleteUser,
} from '../users.js';
import type { Db } from '../sessions.js';
import type { AppVariables, UserRole, UserStatus } from '../types.js';

export function createAdminRoutes(db: Db) {
  const admin = new Hono<{ Variables: AppVariables }>();

  admin.get('/users', authMiddleware(db), usersManageMiddleware(db), (c) => {
    const roleRaw = c.req.query('role') ?? 'all';
    const statusRaw = c.req.query('status') ?? 'all';
    const role = roleRaw === 'admin' || roleRaw === 'member' ? roleRaw : 'all';
    const status =
      statusRaw === 'active' ||
      statusRaw === 'disabled' ||
      statusRaw === 'deleted'
        ? statusRaw
        : 'all';
    const users = listUsers(db, {
      role: role as UserRole | 'all',
      status: status as UserStatus | 'all',
    });
    return c.json({ users: users.map(toUserPublic) });
  });

  admin.post('/users', authMiddleware(db), usersManageMiddleware(db), async (c) => {
    const actor = c.get('user')!;
    const body = await c.req.json().catch(() => ({}));
    const { username: rawUsername, password, display_name, role: rawRole } = body as {
      username?: string;
      password?: string;
      display_name?: string;
      role?: UserRole;
    };
    const usernameError = validateUsername(rawUsername ?? '');
    if (usernameError) return c.json({ error: usernameError }, 400);
    const passwordError = validatePassword(password ?? '');
    if (passwordError) return c.json({ error: passwordError }, 400);
    const role = rawRole === 'admin' ? 'admin' : 'member';
    if (role === 'admin' && actor.role !== 'admin') {
      return c.json({ error: 'Forbidden: only admin can create admin users' }, 403);
    }
    const now = new Date().toISOString();
    const id = generateUserId();
    const passwordHash = await hashPassword(password!);
    const result = createUser(db, {
      id,
      username: rawUsername!.toLowerCase(),
      password_hash: passwordHash,
      display_name: display_name || rawUsername!.toLowerCase(),
      role,
      status: 'active',
      created_at: now,
      updated_at: now,
    });
    if (!result.ok) {
      return c.json({ error: 'Username already taken' }, 400);
    }
    if (role === 'admin') {
      setUserRole(db, id, role, getDefaultPermissions(role));
    }
    insertAuthAudit(db, {
      event_type: 'user_created',
      username: rawUsername!.toLowerCase(),
      actor_username: actor.username,
      ip_address: clientIp(c),
      details: { source: 'admin', role },
    });
    const user = getUserById(db, id)!;
    return c.json({ success: true, user: toUserPublic(user) }, 201);
  });

  admin.patch('/users/:id', authMiddleware(db), usersManageMiddleware(db), async (c) => {
    const actor = c.get('user')!;
    const id = c.req.param('id');
    const target = getUserById(db, id);
    if (!target) return c.json({ error: 'User not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const { role, status, disable_reason } = body as {
      role?: UserRole;
      status?: UserStatus;
      disable_reason?: string;
    };

    if (role !== undefined && role !== 'admin' && role !== 'member') {
      return c.json({ error: 'Invalid role' }, 400);
    }
    if (role !== undefined && role !== target.role && actor.role !== 'admin') {
      return c.json({ error: 'Forbidden: only admin can change roles' }, 403);
    }
    if (role !== undefined && role === 'member' && id === actor.id) {
      return c.json({ error: 'Cannot remove your own admin role' }, 400);
    }
    if (status === 'disabled' && id === actor.id) {
      return c.json({ error: 'Cannot disable your own account' }, 400);
    }
    if (actor.role !== 'admin' && target.role === 'admin') {
      return c.json({ error: 'Forbidden: cannot manage other admins' }, 403);
    }

    if (role !== undefined && role !== target.role) {
      setUserRole(db, id, role, getDefaultPermissions(role));
      insertAuthAudit(db, {
        event_type: 'role_changed',
        username: target.username,
        actor_username: actor.username,
        ip_address: clientIp(c),
        details: { from: target.role, to: role },
      });
    }
    if (status !== undefined) {
      if (status === 'disabled') {
        disableUser(db, id, disable_reason ?? 'disabled_by_admin');
      } else if (status === 'active') {
        enableUser(db, id);
      }
      insertAuthAudit(db, {
        event_type: 'user_status_changed',
        username: target.username,
        actor_username: actor.username,
        ip_address: clientIp(c),
        details: { status },
      });
    }
    const updated = getUserById(db, id)!;
    return c.json({ success: true, user: toUserPublic(updated) });
  });

  admin.post(
    '/users/:id/reset-password',
    authMiddleware(db),
    usersManageMiddleware(db),
    async (c) => {
      const actor = c.get('user')!;
      const id = c.req.param('id');
      const target = getUserById(db, id);
      if (!target) return c.json({ error: 'User not found' }, 404);
      const body = await c.req.json().catch(() => ({}));
      const { password } = body as { password?: string };
      const passwordError = validatePassword(password ?? '');
      if (passwordError) return c.json({ error: passwordError }, 400);
      const passwordHash = await hashPassword(password!);
      resetUserPassword(db, id, passwordHash, id !== actor.id);
      revokeAllUserSessions(db, id);
      insertAuthAudit(db, {
        event_type: 'password_reset',
        username: target.username,
        actor_username: actor.username,
        ip_address: clientIp(c),
      });
      return c.json({ success: true });
    },
  );

  admin.delete('/users/:id', authMiddleware(db), usersManageMiddleware(db), (c) => {
    const actor = c.get('user')!;
    const id = c.req.param('id');
    const target = getUserById(db, id);
    if (!target) return c.json({ error: 'User not found' }, 404);
    if (actor.role !== 'admin' && target.role === 'admin') {
      return c.json({ error: 'Forbidden: cannot delete admins' }, 403);
    }
    softDeleteUser(db, id);
    insertAuthAudit(db, {
      event_type: 'user_deleted',
      username: target.username,
      actor_username: actor.username,
      ip_address: clientIp(c),
    });
    return c.json({ success: true });
  });

  admin.post('/users/:id/restore', authMiddleware(db), usersManageMiddleware(db), (c) => {
    const actor = c.get('user')!;
    const id = c.req.param('id');
    const target = findUser(db, id);
    if (!target) return c.json({ error: 'User not found' }, 404);
    restoreUser(db, id);
    insertAuthAudit(db, {
      event_type: 'user_restored',
      username: target.username,
      actor_username: actor.username,
      ip_address: clientIp(c),
    });
    const updated = getUserById(db, id)!;
    return c.json({ success: true, user: toUserPublic(updated) });
  });

  admin.delete('/users/:id/sessions', authMiddleware(db), usersManageMiddleware(db), (c) => {
    const id = c.req.param('id');
    if (!getUserById(db, id)) return c.json({ error: 'User not found' }, 404);
    revokeAllUserSessions(db, id);
    return c.json({ success: true });
  });

  admin.get('/invites', authMiddleware(db), inviteManageMiddleware(db), (c) => {
    return c.json({ invites: listInvites(db) });
  });

  admin.post('/invites', authMiddleware(db), inviteManageMiddleware(db), async (c) => {
    const actor = c.get('user')!;
    const body = await c.req.json().catch(() => ({}));
    const { max_uses, expires_in_days, role: rawRole } = body as {
      max_uses?: number;
      expires_in_days?: number;
      role?: UserRole;
    };
    const role = rawRole === 'admin' ? 'admin' : 'member';
    if (role === 'admin' && actor.role !== 'admin') {
      return c.json({ error: 'Forbidden: only admin can create admin invites' }, 403);
    }
    const now = new Date();
    const expires_at =
      expires_in_days && expires_in_days > 0
        ? new Date(now.getTime() + expires_in_days * 24 * 60 * 60 * 1000).toISOString()
        : undefined;
    createInvite(db, {
      code: generateInviteCode(),
      created_by: actor.id,
      role,
      max_uses: typeof max_uses === 'number' && max_uses > 0 ? Math.floor(max_uses) : 1,
      expires_at,
      created_at: now.toISOString(),
    });
    const invites = listInvites(db);
    return c.json({ success: true, invite: invites[0] }, 201);
  });

  admin.delete('/invites/:code', authMiddleware(db), inviteManageMiddleware(db), (c) => {
    const ok = revokeInvite(db, c.req.param('code'));
    if (!ok) return c.json({ error: 'Invite not found' }, 404);
    return c.json({ success: true });
  });

  admin.get('/audit', authMiddleware(db), auditViewMiddleware(db), (c) => {
    return c.json({ logs: queryAuditLogs(db) });
  });

  return admin;
}
