import { afterEach, describe, expect, it } from 'vitest';
import { FakePiRunner } from '@deep-worker/pi-runner';
import { createApp } from '../app.js';
import { initDatabase } from '../db/migration.js';
import { cookieValue, jsonRequest } from '../helpers/test-app.js';

describe('agent router routes', () => {
  let app: ReturnType<typeof createApp> | undefined;
  let db: ReturnType<typeof initDatabase> | undefined;

  afterEach(async () => {
    await app?.close();
    db?.close();
    app = undefined;
    db = undefined;
  });

  it('creates a capability-aware plan, tracks tasks and dispatches it', async () => {
    db = initDatabase(':memory:');
    app = createApp({ db, runner: new FakePiRunner({ delayMs: 10, response: (request) => `完成：${request.message}` }) });
    const setup = await app.request('/api/auth/setup', jsonRequest('/api/auth/setup', { username: 'owner', password: 'password123' }));
    expect(setup.status).toBe(201);
    const cookie = cookieValue(setup);
    const profileResponse = await app.request('/api/agent-profiles', jsonRequest('/api/agent-profiles', { name: '研发 Agent' }, cookie));
    const profile = (await profileResponse.json()) as { agent_profile: { id: string } };
    const operationsProfileResponse = await app.request('/api/agent-profiles', jsonRequest('/api/agent-profiles', { name: '运维 Agent' }, cookie));
    const operationsProfile = (await operationsProfileResponse.json()) as { agent_profile: { id: string } };
    const workspaceResponse = await app.request('/api/workspaces', jsonRequest('/api/workspaces', { name: '编排工作区', agent_profile_id: profile.agent_profile.id }, cookie));
    const workspace = (await workspaceResponse.json()) as { workspace: { jid: string } };
    const jid = workspace.workspace.jid;
    const binding = await app.request(`/api/workspaces/${jid}/agents`, jsonRequest(`/api/workspaces/${jid}/agents`, { agent_profile_id: profile.agent_profile.id, capabilities: ['code'], role_tags: ['engineering'], priority: 10 }, cookie));
    expect(binding.status).toBe(201);
    const operationsBinding = await app.request(`/api/workspaces/${jid}/agents`, jsonRequest(`/api/workspaces/${jid}/agents`, { agent_profile_id: operationsProfile.agent_profile.id, capabilities: ['deploy'], role_tags: ['operations'], priority: 10 }, cookie));
    expect(operationsBinding.status).toBe(201);

    const planned = await app.request(`/api/workspaces/${jid}/router/plans`, jsonRequest(`/api/workspaces/${jid}/router/plans`, { message: '请修复代码并发布上线' }, cookie));
    expect(planned.status).toBe(201);
    const plan = (await planned.json()) as { plan: { id: string; status: string; approval_required: boolean; route: { tasks: unknown[] } } };
    expect(plan.plan.route.tasks).toHaveLength(2);
    expect(plan.plan.status).toBe('awaiting_approval');
    expect(plan.plan.approval_required).toBe(true);

    const detail = await app.request(`/api/workspaces/${jid}/router/plans/${plan.plan.id}`, { headers: { cookie: `dw_session=${cookie}` } });
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { tasks: unknown[] };
    expect(detailBody.tasks).toHaveLength(2);
    const blocked = await app.request(`/api/workspaces/${jid}/router/plans/${plan.plan.id}/dispatch`, { method: 'POST', headers: { cookie: `dw_session=${cookie}` } });
    expect(blocked.status).toBe(409);
    const approved = await app.request(`/api/workspaces/${jid}/router/plans/${plan.plan.id}/approve`, { method: 'POST', headers: { cookie: `dw_session=${cookie}` } });
    expect(approved.status).toBe(200);
    const repeatedApproval = await app.request(`/api/workspaces/${jid}/router/plans/${plan.plan.id}/approve`, { method: 'POST', headers: { cookie: `dw_session=${cookie}` } });
    expect(repeatedApproval.status).toBe(409);
    const [dispatched, concurrent] = await Promise.all([
      app.request(`/api/workspaces/${jid}/router/plans/${plan.plan.id}/dispatch`, { method: 'POST', headers: { cookie: `dw_session=${cookie}` } }),
      app.request(`/api/workspaces/${jid}/router/plans/${plan.plan.id}/dispatch`, { method: 'POST', headers: { cookie: `dw_session=${cookie}` } }),
    ]);
    expect([dispatched.status, concurrent.status].sort()).toEqual([200, 409]);
    const resultResponse = dispatched.status === 200 ? dispatched : concurrent;
    const result = (await resultResponse.json()) as { result: { status: string; tasks: Array<{ status: string }> } };
    expect(result.result.status).toBe('completed');
    expect(result.result.tasks).toHaveLength(2);
    expect(result.result.tasks.every((task) => task.status === 'completed')).toBe(true);
  });
});
