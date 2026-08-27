import { describe, expect, it } from 'vitest';
import { cookieValue, cookieRequest, jsonRequest, makeApp } from '../helpers/test-app.js';
import { upsertPlugin } from '../capabilities/plugin-catalog.js';

async function setup(app: ReturnType<typeof makeApp>['app']): Promise<string> {
  const response = await app.request('/api/auth/setup', jsonRequest('/api/auth/setup', { username: 'admin', password: 'password123' }));
  expect(response.status).toBe(201);
  return cookieValue(response);
}

describe('能力治理 API', () => {
  it('列出能力、生成预览并保护 Builder 发布流程', async () => {
    const { app } = makeApp();
    const cookie = await setup(app);
    let response = await app.request('/api/capabilities/skills', cookieRequest(cookie));
    expect(response.status).toBe(200);
    const skills = (await response.json()) as { skills: Array<{ id: string }> };
    expect(skills.skills.some((skill) => skill.id === 'builtin:bash')).toBe(true);

    response = await app.request('/api/capabilities/preview', jsonRequest('/api/capabilities/preview', { selected_skill_ids: ['builtin:bash'] }, cookie));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { preview: { hash: string } }).preview.hash).toMatch(/^[a-f0-9]{64}$/);

    response = await app.request('/api/capabilities/agent-builder/drafts', jsonRequest('/api/capabilities/agent-builder/drafts', { title: 'API 助手', definition: { name: 'API 助手', identity_prompt: '帮助用户' } }, cookie));
    expect(response.status).toBe(201);
    const draft = (await response.json()) as { draft: { id: string } };
    response = await app.request(`/api/capabilities/agent-builder/drafts/${draft.draft.id}/prepare`, jsonRequest('', {}, cookie));
    expect(response.status).toBe(200);
    const prepared = (await response.json()) as { confirmation_code: string; action_id: string };
    response = await app.request(`/api/capabilities/agent-builder/drafts/${draft.draft.id}/publish`, jsonRequest('', { confirmation_code: prepared.confirmation_code, action_id: `${prepared.action_id}-later` }, cookie));
    expect(response.status).toBe(201);
    response = await app.request(`/api/capabilities/agent-builder/drafts/${draft.draft.id}/publish`, jsonRequest('', { confirmation_code: prepared.confirmation_code, action_id: 'another-action' }, cookie));
    expect(response.status).toBe(400);
  });

  it('不在 MCP Server 列表响应中返回密文配置', async () => {
    const { app } = makeApp();
    const cookie = await setup(app);
    const create = await app.request('/api/capabilities/mcp-servers', jsonRequest('/api/capabilities/mcp-servers', { name: 'demo', transport: 'stdio', command: 'demo', credentials: { token: 'secret' } }, cookie));
    expect(create.status).toBe(201);
    const list = await app.request('/api/capabilities/mcp-servers', cookieRequest(cookie));
    const body = (await list.json()) as { mcp_servers: Array<Record<string, unknown>> };
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(body.mcp_servers[0]).not.toHaveProperty('config_encrypted');
  });

  it('阻止普通成员修改全局 Plugin，系统管理员可以修改', async () => {
    const { app, db } = makeApp();
    const adminCookie = await setup(app);
    const memberResponse = await app.request('/api/auth/register', jsonRequest('/api/auth/register', { username: 'member', password: 'password123' }));
    expect(memberResponse.status).toBe(201);
    const memberCookie = cookieValue(memberResponse);
    const plugin = upsertPlugin(db, { ownerUserId: null, name: 'global-demo', version: '1.0.0', source: 'system', manifest: {} });

    let response = await app.request(`/api/capabilities/plugins/${plugin.id}`, jsonRequest('', { enabled: true }, memberCookie, 'PATCH'));
    expect(response.status).toBe(403);
    response = await app.request(`/api/capabilities/plugins/${plugin.id}`, jsonRequest('', { enabled: true }, adminCookie, 'PATCH'));
    expect(response.status).toBe(200);
  });
});
