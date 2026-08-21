import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakePiRunner } from '@deep-worker/pi-runner';
import { createApp } from '../app.js';
import { initDatabase } from '../db/migration.js';
import { cookieValue, jsonRequest } from '../helpers/test-app.js';
import { runnerLifecycle } from '../runner-lifecycle.js';

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

  it('管理员可以更新挂载 allowlist，更新期间完成运行器暂停与恢复', async () => {
    while (runnerLifecycle.isPaused()) runnerLifecycle.resume();
    const app = createApp({ db: initDatabase(':memory:'), runner: new FakePiRunner() });
    const setup = await app.request('/api/auth/setup', jsonRequest('/api/auth/setup', { username: 'admin', password: 'password123' }));
    const cookie = `dw_session=${cookieValue(setup)}`;
    const allowedRoot = path.resolve('workspace');
    const update = await app.request('/api/monitor/mount-allowlist', {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ allowedRoots: [{ path: allowedRoot, allowReadWrite: false }], blockedPatterns: ['.env'] }),
    });
    expect(update.status).toBe(200);
    expect(runnerLifecycle.isPaused()).toBe(false);
    const read = await app.request('/api/monitor/mount-allowlist', { headers: { cookie } });
    expect(await read.json()).toEqual({ allowedRoots: [{ path: allowedRoot, allowReadWrite: false }], blockedPatterns: ['.env'] });
    await app.close();
  });
});
