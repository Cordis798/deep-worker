import { describe, expect, it } from 'vitest';
import { hashPassword, signSessionToken } from '../auth.js';
import { createUser } from '../users.js';
import { cookieValue, cookieRequest, jsonRequest, makeApp } from '../helpers/test-app.js';

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

describe('auth routes', () => {
  it('reports status and initializes a single admin via setup', async () => {
    const { app } = makeApp();
    let response = await app.request('/api/auth/status');
    await expect(response.json()).resolves.toEqual({ initialized: false });

    const adminCookie = await setupAdmin(app);
    expect(adminCookie.length).toBeGreaterThan(0);

    const second = await app.request(
      '/api/auth/setup',
      jsonRequest('/api/auth/setup', {
        username: 'admin2',
        password: 'password456',
      }),
    );
    expect(second.status).toBe(403);

    response = await app.request('/api/auth/status');
    await expect(response.json()).resolves.toEqual({ initialized: true });
  });

  it('logs in, reads me, logs out, then rejects stale session', async () => {
    const { app } = makeApp();
    const adminCookie = await setupAdmin(app);

    const wrong = await app.request(
      '/api/auth/login',
      jsonRequest('/api/auth/login', {
        username: 'admin',
        password: 'wrong-password',
      }),
    );
    expect(wrong.status).toBe(401);

    const login = await app.request(
      '/api/auth/login',
      jsonRequest('/api/auth/login', { username: 'ADMIN', password: 'password123' }),
    );
    expect(login.status).toBe(200);
    const cookie = cookieValue(login);

    let response = await app.request('/api/auth/me');
    expect(response.status).toBe(401);
    response = await app.request('/api/auth/me', cookieRequest(cookie));
    expect(response.status).toBe(200);
    const me = (await response.json()) as { user: { username: string } };
    expect(me.user.username).toBe('admin');

    response = await app.request(
      '/api/auth/logout',
      cookieRequest(cookie, 'POST'),
    );
    expect(response.status).toBe(200);
    response = await app.request('/api/auth/me', cookieRequest(cookie));
    expect(response.status).toBe(401);
    expect(adminCookie).toBeTruthy();
  });

  it('rejects an expired session', async () => {
    const { db, app } = makeApp();
    const now = new Date().toISOString();
    createUser(db, {
      id: 'u-expired',
      username: 'expired',
      password_hash: await hashPassword('password123'),
      display_name: 'expired',
      created_at: now,
      updated_at: now,
    });
    db.prepare(
      `INSERT INTO user_sessions (id, user_id, created_at, expires_at, last_active_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      'expired-token',
      'u-expired',
      now,
      new Date(Date.now() - 1000).toISOString(),
      now,
    );
    const cookie = signSessionToken('expired-token');
    const response = await app.request('/api/auth/me', {
      headers: { cookie: `dw_session=${cookie}` },
    });
    expect(response.status).toBe(401);
  });

  it('registers a member when allowed and rejects a taken username', async () => {
    const { app } = makeApp();
    await setupAdmin(app);

    let response = await app.request('/api/auth/register/status');
    await expect(response.json()).resolves.toMatchObject({ allowRegistration: true });

    response = await app.request(
      '/api/auth/register',
      jsonRequest('/api/auth/register', {
        username: 'alice',
        password: 'password123',
        display_name: 'Alice',
      }),
    );
    expect(response.status).toBe(201);
    expect(cookieValue(response).length).toBeGreaterThan(0);

    const dup = await app.request(
      '/api/auth/register',
      jsonRequest('/api/auth/register', {
        username: 'alice',
        password: 'password123',
      }),
    );
    expect(dup.status).toBe(400);
  });
});
