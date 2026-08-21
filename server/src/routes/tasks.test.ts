import { describe, expect, it } from 'vitest';
import { FakePiRunner } from '@deep-worker/pi-runner';
import { createApp, type App } from '../app.js';
import { initDatabase } from '../db/migration.js';
import { cookieValue, jsonRequest } from '../helpers/test-app.js';

async function setup(app: App) {
  const setupResponse = await app.request('/api/auth/setup', jsonRequest('/api/auth/setup', { username: 'admin', password: 'password123' }));
  const cookie = cookieValue(setupResponse);
  const workspaceResponse = await app.request('/api/workspaces', jsonRequest('/api/workspaces', { name: '任务工作区' }, cookie));
  const workspace = await workspaceResponse.json() as { workspace: { jid: string } };
  return { cookie, jid: workspace.workspace.jid };
}

async function waitForRun(app: App, cookie: string, taskId: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await app.request(`/api/tasks/${taskId}/runs`, { headers: { cookie: `dw_session=${cookie}` } });
    const body = await response.json() as { runs: Array<{ status: string; result_text: string | null }> };
    if (body.runs[0]?.status === 'completed' || body.runs[0]?.status === 'failed') return body.runs[0];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('任务运行没有在预期时间内结束');
}

describe('任务与记忆接口', () => {
  it('通过 Pi Runner 执行任务并保持手动运行幂等', async () => {
    const app = createApp({ db: initDatabase(':memory:'), runner: new FakePiRunner({ response: '任务回复' }) });
    const { cookie, jid } = await setup(app);
    const created = await app.request('/api/tasks', jsonRequest('/api/tasks', {
      workspace_jid: jid,
      name: '测试任务',
      execution_type: 'agent',
      schedule_type: 'interval',
      schedule_value: '60000',
      prompt: '执行测试',
      context_mode: 'isolated',
    }, cookie));
    expect(created.status).toBe(201);
    const task = await created.json() as { task: { id: string } };
    const first = await app.request(`/api/tasks/${task.task.id}/run`, {
      ...jsonRequest(`/api/tasks/${task.task.id}/run`, { idempotency_key: 'same-run' }, cookie),
    });
    const second = await app.request(`/api/tasks/${task.task.id}/run`, {
      ...jsonRequest(`/api/tasks/${task.task.id}/run`, { idempotency_key: 'same-run' }, cookie),
    });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstRun = await first.json() as { run: { id: string } };
    const secondRun = await second.json() as { run: { id: string } };
    expect(secondRun.run.id).toBe(firstRun.run.id);
    expect((await waitForRun(app, cookie, task.task.id)).status).toBe('completed');
    await app.close();
  });

  it('记忆更新使用版本号并暴露冲突', async () => {
    const app = createApp({ db: initDatabase(':memory:'), runner: new FakePiRunner() });
    const { cookie, jid } = await setup(app);
    const created = await app.request(`/api/workspaces/${jid}/memory`, jsonRequest(`/api/workspaces/${jid}/memory`, {
      kind: 'fact', title: '环境', content: '测试环境', source: 'web_user',
    }, cookie));
    expect(created.status).toBe(201);
    const memory = await created.json() as { memory: { id: string; revision: number } };
    const updated = await app.request(`/api/workspaces/${jid}/memory/${memory.memory.id}`, {
      ...jsonRequest(`/api/workspaces/${jid}/memory/${memory.memory.id}`, { expected_revision: 1, content: '已更新' }, cookie, 'PATCH'),
    });
    expect(updated.status).toBe(200);
    const conflict = await app.request(`/api/workspaces/${jid}/memory/${memory.memory.id}`, {
      ...jsonRequest(`/api/workspaces/${jid}/memory/${memory.memory.id}`, { expected_revision: 1, content: '覆盖' }, cookie, 'PATCH'),
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { code: string }).code).toBe('revision_conflict');
    await app.close();
  });
});
