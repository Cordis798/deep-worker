import { Hono } from 'hono';
import {
  checkLoginRateLimit,
  clearLoginAttempts,
  clearSessionCookie,
  generateSessionToken,
  generateUserId,
  hashPassword,
  recordLoginAttempt,
  sessionExpiresAt,
  setSessionCookie,
  validatePassword,
  validateUsername,
  verifyPassword,
} from '../auth.js';
import { insertAuthAudit } from '../audit.js';
import {
  allowRegistration,
  loginLockoutMinutes,
  maxLoginAttempts,
  requireInviteCode,
} from '../config.js';
import { consumeInvite } from '../invites.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  createUserSession,
  deleteOwnSession,
  deleteUserSession,
  listUserSessions,
} from '../sessions.js';
import { clientIp } from '../utils.js';
import {
  createInitialAdminUser,
  createUser,
  countUsers,
  getUserById,
  getUserByUsername,
} from '../users.js';
import { toUserPublic } from '../utils.js';
import type { Db } from '../sessions.js';
import type { AppVariables } from '../types.js';

export function createAuthRoutes(db: Db) {
  const auth = new Hono<{ Variables: AppVariables }>();

  auth.get('/status', (c) => {
    const initialized = countUsers(db) > 0;
    return c.json({ initialized });
  });

  auth.post('/setup', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { username: rawUsername, password } = body as {
      username?: string;
      password?: string;
    };
    if (!rawUsername || !password) {
      return c.json({ error: 'Username and password are required' }, 400);
    }
    const usernameError = validateUsername(rawUsername);
    if (usernameError) return c.json({ error: usernameError }, 400);
    const username = rawUsername.toLowerCase();
    const passwordError = validatePassword(password);
    if (passwordError) return c.json({ error: passwordError }, 400);

    const now = new Date().toISOString();
    const userId = generateUserId();
    const passwordHash = await hashPassword(password);
    const ip = clientIp(c);
    const ua = c.req.header('user-agent') ?? null;

    const result = createInitialAdminUser(db, {
      id: userId,
      username,
      password_hash: passwordHash,
      display_name: username,
      role: 'admin',
      status: 'active',
      must_change_password: false,
      notes: 'Initial admin (setup wizard)',
      created_at: now,
      updated_at: now,
    });
    if (!result.ok) {
      if (result.reason === 'already_initialized') {
        return c.json({ error: 'System already initialized' }, 403);
      }
      return c.json({ error: 'Username already taken' }, 400);
    }

    insertAuthAudit(db, {
      event_type: 'user_created',
      username,
      actor_username: 'system',
      ip_address: ip,
      user_agent: ua,
      details: { source: 'setup_wizard', role: 'admin' },
    });

    const token = generateSessionToken();
    createUserSession(db, {
      id: token,
      user_id: userId,
      ip_address: ip,
      user_agent: ua,
      created_at: now,
      expires_at: sessionExpiresAt(),
      last_active_at: now,
    });
    c.header('Set-Cookie', setSessionCookie(c, token));
    const user = getUserById(db, userId)!;
    return c.json({ success: true, user: toUserPublic(user) }, 201);
  });

  auth.post('/login', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { username: rawUsername, password } = body as {
      username?: string;
      password?: string;
    };
    if (!rawUsername || !password) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }
    const username = rawUsername.toLowerCase();
    const ip = clientIp(c);
    const ua = c.req.header('user-agent') ?? null;

    const maxAttempts = maxLoginAttempts();
    const lockout = loginLockoutMinutes();
    const rateCheck = checkLoginRateLimit(username, ip, maxAttempts, lockout);
    if (!rateCheck.allowed) {
      insertAuthAudit(db, {
        event_type: 'login_failed',
        username,
        ip_address: ip,
        user_agent: ua,
        details: { reason: 'rate_limited' },
      });
      return c.json(
        {
          error: `Too many login attempts. Try again in ${rateCheck.retryAfterSeconds}s`,
        },
        429,
      );
    }

    const user = getUserByUsername(db, username);
    const DUMMY_HASH =
      '$2b$12$GBXvNon/zJbUI4jtleGnP.YX03zXP5eSXjppo7a3vyWEUK/2YwdP.';
    let passwordMatch = false;
    try {
      passwordMatch = await verifyPassword(
        password,
        user ? user.password_hash : DUMMY_HASH,
      );
    } catch {
      passwordMatch = false;
    }

    if (!user || user.status !== 'active' || !passwordMatch) {
      recordLoginAttempt(username, ip);
      insertAuthAudit(db, {
        event_type: 'login_failed',
        username,
        ip_address: ip,
        user_agent: ua,
        details: { reason: 'invalid_credentials' },
      });
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    const now = new Date().toISOString();
    const token = generateSessionToken();
    createUserSession(db, {
      id: token,
      user_id: user.id,
      ip_address: ip,
      user_agent: ua,
      created_at: now,
      expires_at: sessionExpiresAt(),
      last_active_at: now,
    });
    clearLoginAttempts(username, ip);
    insertAuthAudit(db, {
      event_type: 'login_success',
      username,
      ip_address: ip,
      user_agent: ua,
    });
    c.header('Set-Cookie', setSessionCookie(c, token));
    const updated = getUserById(db, user.id) ?? user;
    return c.json({ success: true, user: toUserPublic(updated) });
  });

  auth.get('/register/status', (c) => {
    if (countUsers(db) === 0) {
      return c.json({ allowRegistration: false, requireInviteCode: true });
    }
    return c.json({
      allowRegistration: allowRegistration(),
      requireInviteCode: requireInviteCode(),
    });
  });

  auth.post('/register', async (c) => {
    if (countUsers(db) === 0) {
      return c.json({ error: '系统尚未初始化，请先完成管理员设置。' }, 403);
    }
    if (!allowRegistration()) {
      return c.json({ error: '注册功能已关闭' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const { username: rawUsername, password, display_name, invite_code } = body as {
      username?: string;
      password?: string;
      display_name?: string;
      invite_code?: string;
    };
    if (requireInviteCode() && !invite_code) {
      return c.json({ error: '需要提供邀请码' }, 400);
    }
    const usernameError = validateUsername(rawUsername ?? '');
    if (usernameError) return c.json({ error: usernameError }, 400);
    const passwordError = validatePassword(password ?? '');
    if (passwordError) return c.json({ error: passwordError }, 400);
    const username = rawUsername!.toLowerCase();
    const ip = clientIp(c);

    let role: 'member' = 'member';
    if (invite_code) {
      const invite = consumeInvite(db, invite_code);
      if (!invite.ok) {
        recordLoginAttempt(`register:${ip}`, ip);
        return c.json({ error: 'Invalid or expired invite code' }, 400);
      }
      if (invite.role && invite.role !== 'member') {
        role = invite.role as 'member';
      }
    }

    const now = new Date().toISOString();
    const userId = generateUserId();
    const passwordHash = await hashPassword(password!);
    const result = createUser(db, {
      id: userId,
      username,
      password_hash: passwordHash,
      display_name: display_name || username,
      role: role,
      created_at: now,
      updated_at: now,
    });
    if (!result.ok) {
      recordLoginAttempt(`register:${ip}`, ip);
      return c.json({ error: 'Registration failed. Username may already be taken.' }, 400);
    }
    insertAuthAudit(db, {
      event_type: 'register_success',
      username,
      ip_address: ip,
      details: { role, with_invite: !!invite_code },
    });

    const token = generateSessionToken();
    createUserSession(db, {
      id: token,
      user_id: userId,
      ip_address: ip,
      created_at: now,
      expires_at: sessionExpiresAt(),
      last_active_at: now,
    });
    c.header('Set-Cookie', setSessionCookie(c, token));
    const user = getUserById(db, userId)!;
    return c.json({ success: true, user: toUserPublic(user) }, 201);
  });

  auth.post('/logout', authMiddleware(db), (c) => {
    const token = c.get('sessionId')!;
    deleteUserSession(db, token);
    const user = c.get('user')!;
    insertAuthAudit(db, {
      event_type: 'logout',
      username: user.username,
      ip_address: clientIp(c),
    });
    c.header('Set-Cookie', clearSessionCookie(c));
    return c.json({ success: true });
  });

  auth.get('/me', authMiddleware(db), (c) => {
    const user = c.get('user')!;
    const full = getUserById(db, user.id);
    if (!full) return c.json({ error: 'User not found' }, 404);
    return c.json({ user: toUserPublic(full) });
  });

  auth.get('/sessions', authMiddleware(db), (c) => {
    const user = c.get('user')!;
    return c.json({ sessions: listUserSessions(db, user.id) });
  });

  auth.delete('/sessions/:id', authMiddleware(db), (c) => {
    const user = c.get('user')!;
    const ok = deleteOwnSession(db, user.id, c.req.param('id'));
    if (!ok) return c.json({ error: 'Session not found' }, 404);
    return c.json({ success: true });
  });

  return auth;
}
