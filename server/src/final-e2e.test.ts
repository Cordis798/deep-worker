import { describe, expect, it } from 'vitest';
import { FakePiRunner } from '@deep-worker/pi-runner';
import { createApp, type App } from './app.js';
import { initDatabase } from './db/migration.js';
import { cookieValue, jsonRequest } from './helpers/test-app.js';
import { createChannelAccount } from './channel-accounts.js';
import { ChannelManager } from './im/channel-manager.js';
import { FakeTransport } from './im/fake-transport.js';

async function waitForTask(app: App, cookie: string, taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await app.request(`/api/tasks/${taskId}/runs`, { headers: { cookie: `dw_session=${cookie}` } });
    const body = await response.json() as { runs: Array<{ status: string }> };
    if (body.runs[0]?.status === 'completed') return;
    if (body.runs[0]?.status === 'failed') throw new Error('定时任务执行失败');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('定时任务未在预期时间内完成');
}

describe('最终功能闭环', () => {
  it('Setup → 登录 → Agent/Workspace → Fake Pi → 定时任务 → Fake 渠道 → 用量', async () => {
    const db = initDatabase(':memory:');
    const app = createApp({ db, runner: new FakePiRunner({ response: '最终链路回复', emitUsage: true }) });
    const setup = await app.request('/api/auth/setup', jsonRequest('/api/auth/setup', { username: 'admin', password: 'password123' }));
    expect(setup.status).toBe(201);
    await app.request('/api/auth/logout', { method: 'POST', headers: { cookie: `dw_session=${cookieValue(setup)}` } });
    const login = await app.request('/api/auth/login', jsonRequest('/api/auth/login', { username: 'admin', password: 'password123' }));
    const cookie = cookieValue(login);
    const profileResponse = await app.request('/api/agent-profiles', jsonRequest('/api/agent-profiles', { name: '最终验收 Agent', identity_prompt: '负责最终验收' }, cookie));
    const profile = await profileResponse.json() as { agent_profile: { id: string } };
    const workspaceResponse = await app.request('/api/workspaces', jsonRequest('/api/workspaces', { name: '最终验收工作区', agent_profile_id: profile.agent_profile.id }, cookie));
    const workspace = await workspaceResponse.json() as { workspace: { jid: string } };
    const sessionResponse = await app.request(`/api/workspaces/${workspace.workspace.jid}/runtime-sessions`, jsonRequest('', { name: '最终验收会话' }, cookie));
    const session = await sessionResponse.json() as { session: { id: string } };
    const chat = await app.request(`/api/workspaces/${workspace.workspace.jid}/runtime-sessions/${session.session.id}/messages`, jsonRequest('', { message: '请完成最终验收', idempotency_key: 'final-chat-1' }, cookie));
    expect(chat.status).toBe(200);

    const taskResponse = await app.request('/api/tasks', jsonRequest('/api/tasks', { workspace_jid: workspace.workspace.jid, name: '最终验收任务', execution_type: 'agent', schedule_type: 'interval', schedule_value: '60000', prompt: '执行最终验收任务' }, cookie));
    const task = await taskResponse.json() as { task: { id: string } };
    const runResponse = await app.request(`/api/tasks/${task.task.id}/run`, jsonRequest('', { idempotency_key: 'final-task-1' }, cookie));
    expect(runResponse.status).toBe(202);
    await waitForTask(app, cookie, task.task.id);

    const admin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin') as { id: string };
    const accountResult = createChannelAccount(db, admin.id, { provider: 'telegram', name: '最终 Fake 渠道', default_workspace_jid: workspace.workspace.jid, credentials: { token: 'fake-token' } });
    expect(accountResult.ok).toBe(true);
    const account = db.prepare('SELECT id FROM channel_accounts WHERE owner_user_id = ? AND name = ?').get(admin.id, '最终 Fake 渠道') as { id: string };
    const transport = new FakeTransport();
    const replies: string[] = [];
    const manager = new ChannelManager({ db, transportFactory: () => transport, onAgentMessage: async ({ message }) => { replies.push(message.text); return `Fake 渠道回复：${message.text}`; }, retryBaseMs: 0 });
    await manager.connectAccount(admin.id, account.id);
    transport.emitMessage({ externalChatId: 'final-chat', conversation: 'private', senderId: 'final-user', text: '渠道验收' });
    await manager.waitForIdle();
    expect(replies).toEqual(['渠道验收']);
    expect(transport.sent.find((item) => item.kind === 'message')?.text).toBe('Fake 渠道回复：渠道验收');
    await manager.close();

    const stats = await app.request('/api/usage/stats?days=7', { headers: { cookie: `dw_session=${cookie}` } });
    expect(((await stats.json()) as { summary: { runCount: number } }).summary.runCount).toBe(2);
    await app.close();
  });
});
