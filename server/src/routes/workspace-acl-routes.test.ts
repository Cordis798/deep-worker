import { afterEach, describe, expect, it } from 'vitest';
import { cookieValue, jsonRequest, makeApp } from '../helpers/test-app.js';

async function register(app: ReturnType<typeof makeApp>['app'], username: string) {
  const response = await app.request(
    '/api/auth/register',
    jsonRequest('/api/auth/register', { username, password: 'password123' }),
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { user: { id: string } };
  return { cookie: cookieValue(response), userId: body.user.id };
}

describe('workspace ACL routes', () => {
  let current: ReturnType<typeof makeApp> | undefined;

  afterEach(async () => {
    await current?.app.close();
    current?.db.close();
    current = undefined;
  });

  it('shares sessions and profiles with role-specific write access', async () => {
    current = makeApp();
    const { app } = current;
    const setup = await app.request(
      '/api/auth/setup',
      jsonRequest('/api/auth/setup', { username: 'owner', password: 'password123' }),
    );
    expect(setup.status).toBe(201);
    const ownerCookie = cookieValue(setup);
    const member = await register(app, 'member');
    const viewer = await register(app, 'viewer');

    const profileResponse = await app.request(
      '/api/agent-profiles',
      jsonRequest('/api/agent-profiles', { name: 'Shared', identity_prompt: 'shared' }, ownerCookie),
    );
    const profile = (await profileResponse.json()) as { agent_profile: { id: string } };
    const workspaceResponse = await app.request(
      '/api/workspaces',
      jsonRequest(
        '/api/workspaces',
        { name: 'Shared workspace', agent_profile_id: profile.agent_profile.id },
        ownerCookie,
      ),
    );
    const workspace = (await workspaceResponse.json()) as { workspace: { jid: string } };
    const jid = workspace.workspace.jid;

    for (const [userId, role] of [[member.userId, 'member'], [viewer.userId, 'viewer']] as const) {
      const response = await app.request(
        `/api/workspaces/${jid}/members`,
        jsonRequest(`/api/workspaces/${jid}/members`, { user_id: userId, role }, ownerCookie),
      );
      expect(response.status).toBe(201);
    }

    const memberWorkspace = await app.request(`/api/workspaces/${jid}`, {
      headers: { cookie: `dw_session=${member.cookie}` },
    });
    expect(memberWorkspace.status).toBe(200);
    const memberProfiles = await app.request('/api/agent-profiles', {
      headers: { cookie: `dw_session=${member.cookie}` },
    });
    expect(memberProfiles.status).toBe(200);
    const memberProfilesBody = (await memberProfiles.json()) as { agent_profiles: unknown[] };
    expect(memberProfilesBody.agent_profiles).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: profile.agent_profile.id })]),
    );

    const memberSession = await app.request(
      `/api/workspaces/${jid}/runtime-sessions`,
      jsonRequest(`/api/workspaces/${jid}/runtime-sessions`, { name: 'Member session' }, member.cookie),
    );
    expect(memberSession.status).toBe(201);
    const sessionId = ((await memberSession.json()) as { session: { id: string } }).session.id;

    const viewerSession = await app.request(
      `/api/workspaces/${jid}/runtime-sessions`,
      jsonRequest(`/api/workspaces/${jid}/runtime-sessions`, { name: 'Denied' }, viewer.cookie),
    );
    expect(viewerSession.status).toBe(404);
    const viewerList = await app.request(`/api/workspaces/${jid}/runtime-sessions`, {
      headers: { cookie: `dw_session=${viewer.cookie}` },
    });
    expect(viewerList.status).toBe(200);
    const viewerListBody = (await viewerList.json()) as { sessions: unknown[] };
    expect(viewerListBody.sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: sessionId })]),
    );

    const copied = await app.request(
      `/api/workspaces/${jid}/runtime-sessions/${sessionId}/copy`,
      { method: 'POST', headers: { cookie: `dw_session=${member.cookie}` } },
    );
    expect(copied.status).toBe(201);
    const copiedBody = (await copied.json()) as { workspace_jid: string; session_id: string };
    expect(copiedBody.workspace_jid).toMatch(/^web:/);
    const viewerCopy = await app.request(
      `/api/workspaces/${jid}/runtime-sessions/${sessionId}/copy`,
      { method: 'POST', headers: { cookie: `dw_session=${viewer.cookie}` } },
    );
    expect(viewerCopy.status).toBe(404);

    const memberProfileUpdate = await app.request(
      `/api/agent-profiles/${profile.agent_profile.id}`,
      jsonRequest(`/api/agent-profiles/${profile.agent_profile.id}`, { name: 'Member edit' }, member.cookie, 'PATCH'),
    );
    expect(memberProfileUpdate.status).toBe(404);
    const ownerProfileUpdate = await app.request(
      `/api/agent-profiles/${profile.agent_profile.id}`,
      jsonRequest(`/api/agent-profiles/${profile.agent_profile.id}`, { name: 'Admin edit' }, ownerCookie, 'PATCH'),
    );
    expect(ownerProfileUpdate.status).toBe(200);
  });
});
