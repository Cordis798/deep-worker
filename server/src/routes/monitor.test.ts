import { describe, expect, it } from 'vitest';
import { FakePiRunner } from '@deep-worker/pi-runner';
import { createApp } from '../app.js';
import { initDatabase } from '../db/migration.js';
import { cookieValue, jsonRequest } from '../helpers/test-app.js';

describe('监控路由', () => {
  it('管理员可以看到队列、Runner、Container 和 Provider 脱敏状态', async () => {
    const app = createApp({ db: initDatabase(':memory:'), runner: new FakePiRunner() });
    const setup = await app.request('/api/auth/setup', jsonRequest('/api/auth/setup', { username: 'admin', password: 'password123' }));
    const response = await app.request('/api/monitor/status', { headers: { cookie: `dw_session=${cookieValue(setup)}` } });
    expect(response.status).toBe(200);
    const body = await response.json() as { queue: unknown; runners: unknown; providers: unknown };
    expect(body.queue).toBeTruthy();
    expect(body.runners).toBeTruthy();
    expect(body.providers).toEqual([]);
    await app.close();
  });

  it('普通成员不能读取系统监控', async () => {
    const app = createApp({ db: initDatabase(':memory:'), runner: new FakePiRunner() });
    const setup = await app.request('/api/auth/setup', jsonRequest('/api/auth/setup', { username: 'admin', password: 'password123' }));
    const member = await app.request('/api/auth/register', jsonRequest('/api/auth/register', { username: 'member', password: 'password123' }));
    expect(setup.status).toBe(201);
    const response = await app.request('/api/monitor/status', { headers: { cookie: `dw_session=${cookieValue(member)}` } });
    expect(response.status).toBe(403);
    await app.close();
  });
});
