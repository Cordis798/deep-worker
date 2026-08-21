import { describe, expect, it } from 'vitest';
import { FakePiRunner } from '@deep-worker/pi-runner';
import { createApp, type App } from '../app.js';
import { initDatabase } from '../db/migration.js';
import { cookieValue, jsonRequest } from '../helpers/test-app.js';

async function setup(app: App) {
  const response = await app.request('/api/auth/setup', jsonRequest('/api/auth/setup', { username: 'admin', password: 'password123' }));
  const cookie = cookieValue(response);
  const workspaceResponse = await app.request('/api/workspaces', jsonRequest('/api/workspaces', { name: '端到端工作区' }, cookie));
  const workspace = await workspaceResponse.json() as { workspace: { jid: string } };
  const sessionResponse = await app.request(`/api/workspaces/${workspace.workspace.jid}/runtime-sessions`, jsonRequest('', { name: '端到端会话' }, cookie));
  const session = await sessionResponse.json() as { session: { id: string } };
  return { cookie, jid: workspace.workspace.jid, sessionId: session.session.id };
}

describe('用量与计费 API', () => {
  it('Fake Pi 聊天后可查询用量、账务摘要和 CSV', async () => {
    const app = createApp({ db: initDatabase(':memory:'), runner: new FakePiRunner({ response: '计费用量回复', emitUsage: true }) });
    const { cookie, jid, sessionId } = await setup(app);
    const message = await app.request(`/api/workspaces/${jid}/runtime-sessions/${sessionId}/messages`, jsonRequest('', { message: '记录这次用量', idempotency_key: 'billing-e2e-1' }, cookie));
    expect(message.status).toBe(200);
    const stats = await app.request('/api/usage/stats?days=7', { headers: { cookie: `dw_session=${cookie}` } });
    expect(stats.status).toBe(200);
    expect(((await stats.json()) as { summary: { runCount: number } }).summary.runCount).toBe(1);
    const records = await app.request('/api/usage/records', { headers: { cookie: `dw_session=${cookie}` } });
    expect(((await records.json()) as { total: number }).total).toBe(1);
    const csv = await app.request('/api/usage/export.csv', { headers: { cookie: `dw_session=${cookie}` } });
    expect(csv.status).toBe(200);
    expect(await csv.text()).toContain('eventId,createdAt');
    const billing = await app.request('/api/billing/my/summary', { headers: { cookie: `dw_session=${cookie}` } });
    expect(billing.status).toBe(200);
    expect(((await billing.json()) as { plan: { id: string } }).plan.id).toBe('free');
    await app.close();
  });

  it('拒绝非法日期并按 days 参数扩大查询窗口', async () => {
    const app = createApp({ db: initDatabase(':memory:'), runner: new FakePiRunner() });
    const { cookie } = await setup(app);
    const invalid = await app.request('/api/usage/stats?from=2026-02-31&to=2026-03-01', { headers: { cookie: `dw_session=${cookie}` } });
    expect(invalid.status).toBe(400);
    const range = await app.request('/api/usage/stats?days=30', { headers: { cookie: `dw_session=${cookie}` } });
    const range7 = await app.request('/api/usage/stats?days=7', { headers: { cookie: `dw_session=${cookie}` } });
    expect(((await range.json()) as { window: { from: string; to: string } }).window.from).not.toBe(((await range7.json()) as { window: { from: string; to: string } }).window.from);
    await app.close();
  });
});
