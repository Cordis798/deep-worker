import { describe, expect, it, afterEach } from 'vitest';
import {
  cookieRequest,
  cookieValue,
  jsonRequest,
  makeApp,
} from '../helpers/test-app.js';

async function setupAdmin(app: ReturnType<typeof makeApp>['app']): Promise<string> {
  const response = await app.request(
    '/api/auth/setup',
    jsonRequest('/api/auth/setup', {
      username: 'admin',
      password: 'password123',
    }),
  );
  expect(response.status).toBe(201);
  return cookieValue(response);
}

async function registerMember(
  app: ReturnType<typeof makeApp>['app'],
  username: string,
): Promise<string> {
  const response = await app.request(
    '/api/auth/register',
    jsonRequest('/api/auth/register', {
      username,
      password: 'password123',
    }),
  );
  expect(response.status).toBe(201);
  return cookieValue(response);
}

async function login(
  app: ReturnType<typeof makeApp>['app'],
  username: string,
  password: string,
): Promise<string> {
  const response = await app.request(
    '/api/auth/login',
    jsonRequest('/api/auth/login', { username, password }),
  );
  expect(response.status).toBe(200);
  return cookieValue(response);
}

const CLEAN_ENV: Record<string, string | undefined> = {};

afterEach(() => {
  for (const [key, value] of Object.entries(CLEAN_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('admin routes', () => {
  it('lists users and creates a member', async () => {
    const { app } = makeApp();
    const adminCookie = await setupAdmin(app);

    let response = await app.request('/api/admin/users', cookieRequest(adminCookie));
    expect(response.status).toBe(200);
    let body = (await response.json()) as { users: unknown[] };
    expect(body.users.length).toBe(1);

    response = await app.request(
      '/api/admin/users',
      jsonRequest('/api/admin/users', {
        username: 'bob',
        password: 'password123',
      }, adminCookie),
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as { user: { role: string } };
    expect(created.user.role).toBe('member');
  });

  it('denies admin endpoints to a member', async () => {
    const { app } = makeApp();
    await setupAdmin(app);
    const memberCookie = await registerMember(app, 'alice');
    const response = await app.request('/api/admin/users', cookieRequest(memberCookie));
    expect(response.status).toBe(403);
  });

  it('changes a member role to admin and grants permission', async () => {
    const { app } = makeApp();
    const adminCookie = await setupAdmin(app);
    await registerMember(app, 'alice');
    const list = (await (
      await app.request('/api/admin/users', cookieRequest(adminCookie))
    ).json()) as { users: Array<{ id: string; username: string }> };
    const alice = list.users.find((u) => u.username === 'alice')!;

    const patch = await app.request(
      `/api/admin/users/${alice.id}`,
      jsonRequest(
        `/api/admin/users/${alice.id}`,
        { role: 'admin' },
        adminCookie,
        'PATCH',
      ),
    );
    expect(patch.status).toBe(200);
    const body = (await patch.json()) as { user: { role: string } };
    expect(body.user.role).toBe('admin');

    const newAdminCookie = await login(app, 'alice', 'password123');
    const asNewAdmin = await app.request('/api/admin/users', cookieRequest(newAdminCookie));
    expect(asNewAdmin.status).toBe(200);
  });

  it('disables a user and rejects their session and login', async () => {
    const { app } = makeApp();
    const adminCookie = await setupAdmin(app);
    const memberCookie = await registerMember(app, 'alice');
    const list = (await (
      await app.request('/api/admin/users', cookieRequest(adminCookie))
    ).json()) as { users: Array<{ id: string; username: string }> };
    const alice = list.users.find((u) => u.username === 'alice')!;

    const patch = await app.request(
      `/api/admin/users/${alice.id}`,
      jsonRequest(
        `/api/admin/users/${alice.id}`,
        { status: 'disabled' },
        adminCookie,
        'PATCH',
      ),
    );
    expect(patch.status).toBe(200);

    const me = await app.request('/api/auth/me', cookieRequest(memberCookie));
    expect(me.status).toBe(403);
    const loginAgain = await app.request(
      '/api/auth/login',
      jsonRequest('/api/auth/login', {
        username: 'alice',
        password: 'password123',
      }),
    );
    expect(loginAgain.status).toBe(401);
  });

  it('resets a password and revokes sessions', async () => {
    const { app } = makeApp();
    const adminCookie = await setupAdmin(app);
    const memberCookie = await registerMember(app, 'alice');
    const list = (await (
      await app.request('/api/admin/users', cookieRequest(adminCookie))
    ).json()) as { users: Array<{ id: string; username: string }> };
    const alice = list.users.find((u) => u.username === 'alice')!;

    const reset = await app.request(
      `/api/admin/users/${alice.id}/reset-password`,
      jsonRequest(
        `/api/admin/users/${alice.id}/reset-password`,
        { password: 'newpassword123' },
        adminCookie,
      ),
    );
    expect(reset.status).toBe(200);
    const me = await app.request('/api/auth/me', cookieRequest(memberCookie));
    expect(me.status).toBe(401);

    const oldLogin = await app.request(
      '/api/auth/login',
      jsonRequest('/api/auth/login', {
        username: 'alice',
        password: 'password123',
      }),
    );
    expect(oldLogin.status).toBe(401);
    const newLogin = await app.request(
      '/api/auth/login',
      jsonRequest('/api/auth/login', {
        username: 'alice',
        password: 'newpassword123',
      }),
    );
    expect(newLogin.status).toBe(200);
  }, 20000);

  it('returns 404 for a missing user and manages invites and audit', async () => {
    const { app } = makeApp();
    const adminCookie = await setupAdmin(app);

    const missing = await app.request(
      '/api/admin/users/does-not-exist',
      jsonRequest('/api/admin/users/does-not-exist', { role: 'member' }, adminCookie),
    );
    expect(missing.status).toBe(404);

    const invite = await app.request(
      '/api/admin/invites',
      jsonRequest('/api/admin/invites', { max_uses: 2 }, adminCookie),
    );
    expect(invite.status).toBe(201);
    const inviteBody = (await invite.json()) as { invite: { code: string } };

    let invites = await app.request('/api/admin/invites', cookieRequest(adminCookie));
    expect(invites.status).toBe(200);
    let inviteList = (await invites.json()) as { invites: unknown[] };
    expect(inviteList.invites.length).toBe(1);

    const removed = await app.request(
      `/api/admin/invites/${inviteBody.invite.code}`,
      { method: 'DELETE', ...cookieRequest(adminCookie) },
    );
    expect(removed.status).toBe(200);
    invites = await app.request('/api/admin/invites', cookieRequest(adminCookie));
    inviteList = (await invites.json()) as { invites: unknown[] };
    expect(inviteList.invites.length).toBe(0);

    const audit = await app.request('/api/admin/audit', cookieRequest(adminCookie));
    expect(audit.status).toBe(200);
    const auditBody = (await audit.json()) as { logs: unknown[] };
    expect(auditBody.logs.length).toBeGreaterThan(0);
  });
});
