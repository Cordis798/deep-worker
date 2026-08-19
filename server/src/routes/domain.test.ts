import { describe, expect, it, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  cookieRequest,
  cookieValue,
  jsonRequest,
  makeApp,
} from '../helpers/test-app.js';
import { createWorkspace } from '../workspaces.js';

type AppCtx = ReturnType<typeof makeApp>;

function putJson(
  path: string,
  body: unknown,
  cookie: string,
): { method: 'PUT'; headers: Record<string, string>; body: string } {
  return {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      cookie: `dw_session=${cookie}`,
    },
    body: JSON.stringify(body),
  };
}

async function setupAdmin(app: AppCtx['app']): Promise<string> {
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
  app: AppCtx['app'],
  username: string,
): Promise<string> {
  const response = await app.request(
    '/api/auth/register',
    jsonRequest('/api/auth/register', { username, password: 'password123' }),
  );
  expect(response.status).toBe(201);
  return cookieValue(response);
}

async function createAgent(
  app: AppCtx['app'],
  cookie: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const response = await app.request(
    '/api/agent-profiles',
    jsonRequest('/api/agent-profiles', {
      name: 'Helper',
      identity_prompt: 'You are a helper.',
      ...overrides,
    }, cookie),
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { agent_profile: { id: string } };
  return body.agent_profile.id;
}

async function createWorkspaceViaApi(
  app: AppCtx['app'],
  cookie: string,
  name: string,
): Promise<string> {
  const response = await app.request(
    '/api/workspaces',
    jsonRequest('/api/workspaces', { name }, cookie),
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { workspace: { jid: string } };
  return body.workspace.jid;
}

async function createSession(
  app: AppCtx['app'],
  cookie: string,
  jid: string,
): Promise<string> {
  const response = await app.request(
    `/api/workspaces/${jid}/runtime-sessions`,
    jsonRequest(`/api/workspaces/${jid}/runtime-sessions`, { name: 'S' }, cookie),
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { session: { id: string } };
  return body.session.id;
}

describe('P3 domain model and API', () => {
  let db: Database.Database;
  let app: AppCtx['app'];
  let adminCookie: string;

  beforeEach(() => {
    ({ db, app } = makeApp());
    // No setup here; tests set up what they need.
  });

  it('agent profile CRUD, version history, restore and ownership 404', async () => {
    adminCookie = await setupAdmin(app);
    const id = await createAgent(app, adminCookie, {
      name: 'Alice',
      identity_prompt: 'I am Alice.',
    });

    const listed = await app.request('/api/agent-profiles', cookieRequest(adminCookie));
    const list = (await listed.json()) as { agent_profiles: unknown[] };
    expect(list.agent_profiles.length).toBe(1);

    let get = await app.request(`/api/agent-profiles/${id}`, cookieRequest(adminCookie));
    expect(get.status).toBe(200);

    const patched = await app.request(
      `/api/agent-profiles/${id}`,
      jsonRequest(`/api/agent-profiles/${id}`, { identity_prompt: 'I am Alice v2.' }, adminCookie, 'PATCH'),
    );
    expect(patched.status).toBe(200);
    const updated = (await patched.json()) as {
      agent_profile: { version: number; identity_prompt: string };
    };
    expect(updated.agent_profile.version).toBe(2);

    let versions = await app.request(
      `/api/agent-profiles/${id}/prompt-versions`,
      cookieRequest(adminCookie),
    );
    expect(versions.status).toBe(200);
    let versionBody = (await versions.json()) as { versions: unknown[] };
    expect(versionBody.versions.length).toBe(2);

    const restored = await app.request(
      `/api/agent-profiles/${id}/prompt-versions/1/restore`,
      { method: 'POST', ...cookieRequest(adminCookie) },
    );
    expect(restored.status).toBe(200);
    const restoredBody = (await restored.json()) as {
      agent_profile: { version: number; identity_prompt: string };
    };
    expect(restoredBody.agent_profile.version).toBe(3);
    expect(restoredBody.agent_profile.identity_prompt).toBe('I am Alice.');

    versions = await app.request(
      `/api/agent-profiles/${id}/prompt-versions`,
      cookieRequest(adminCookie),
    );
    versionBody = (await versions.json()) as { versions: unknown[] };
    expect(versionBody.versions.length).toBe(3);

    const memberCookie = await registerMember(app, 'member');
    const cross = await app.request(
      `/api/agent-profiles/${id}`,
      cookieRequest(memberCookie),
    );
    expect(cross.status).toBe(404);
  });

  it('rejects deleting a default agent profile or one bound to workspaces', async () => {
    adminCookie = await setupAdmin(app);
    const id = await createAgent(app, adminCookie, { is_default: true });

    const delDefault = await app.request(
      `/api/agent-profiles/${id}`,
      { method: 'DELETE', ...cookieRequest(adminCookie) },
    );
    expect(delDefault.status).toBe(400);

    const id2 = await createAgent(app, adminCookie, { name: 'Bound' });
    const jid = await createWorkspaceViaApi(app, adminCookie, 'W');
    const bound = await app.request(
      `/api/workspaces/${jid}`,
      jsonRequest(`/api/workspaces/${jid}`, { agent_profile_id: id2 }, adminCookie, 'PATCH'),
    );
    expect(bound.status).toBe(200);

    const delBound = await app.request(
      `/api/agent-profiles/${id2}`,
      { method: 'DELETE', ...cookieRequest(adminCookie) },
    );
    expect(delBound.status).toBe(409);
  });

  it('archives an agent profile on delete while keeping prompt versions readable', async () => {
    adminCookie = await setupAdmin(app);
    const id = await createAgent(app, adminCookie, { name: 'ToDelete' });
    const del = await app.request(
      `/api/agent-profiles/${id}`,
      { method: 'DELETE', ...cookieRequest(adminCookie) },
    );
    expect(del.status).toBe(200);

    const versions = await app.request(
      `/api/agent-profiles/${id}/prompt-versions`,
      cookieRequest(adminCookie),
    );
    expect(versions.status).toBe(200);
    const body = (await versions.json()) as { versions: unknown[] };
    expect(body.versions.length).toBe(1);

    const patchAfter = await app.request(
      `/api/agent-profiles/${id}`,
      jsonRequest(`/api/agent-profiles/${id}`, { name: 'X' }, adminCookie, 'PATCH'),
    );
    expect(patchAfter.status).toBe(409);
  });

  it('workspace CRUD, home not deletable, agent migration and ownership 404', async () => {
    adminCookie = await setupAdmin(app);
    const jid = await createWorkspaceViaApi(app, adminCookie, 'Data');

    const list = await app.request('/api/workspaces', cookieRequest(adminCookie));
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { workspaces: unknown[] };
    expect(listBody.workspaces.length).toBe(1);

    let rename = await app.request(
      `/api/workspaces/${jid}`,
      jsonRequest(`/api/workspaces/${jid}`, { name: 'Renamed' }, adminCookie, 'PATCH'),
    );
    expect(rename.status).toBe(200);

    const me = (await (
      await app.request('/api/auth/me', cookieRequest(adminCookie))
    ).json()) as { user: { id: string } };
    const home = createWorkspace(db, me.user.id, {
      name: 'Home',
      is_home: true,
      folder: 'home',
    });
    expect(home).toBeTruthy();
    const delHome = await app.request(
      `/api/workspaces/${home!.jid}`,
      { method: 'DELETE', ...cookieRequest(adminCookie) },
    );
    expect(delHome.status).toBe(409);

    const customProfile = await createAgent(app, adminCookie, { name: 'Custom' });
    const migrateHome = await app.request(
      `/api/workspaces/${home!.jid}`,
      jsonRequest(
        `/api/workspaces/${home!.jid}`,
        { agent_profile_id: customProfile },
        adminCookie,
        'PATCH',
      ),
    );
    expect(migrateHome.status).toBe(409);

    const memberCookie = await registerMember(app, 'member');
    const cross = await app.request(`/api/workspaces/${jid}`, cookieRequest(memberCookie));
    expect(cross.status).toBe(404);

    const del = await app.request(
      `/api/workspaces/${jid}`,
      { method: 'DELETE', ...cookieRequest(adminCookie) },
    );
    expect(del.status).toBe(200);
    const after = await app.request(`/api/workspaces/${jid}`, cookieRequest(adminCookie));
    expect(after.status).toBe(404);
  });

  it('rejects cross-user agent profile references in workspaces and sessions', async () => {
    adminCookie = await setupAdmin(app);
    const memberCookie = await registerMember(app, 'member');
    const memberProfile = await createAgent(app, memberCookie, {
      name: 'MemberAgent',
    });

    const create = await app.request(
      '/api/workspaces',
      jsonRequest(
        '/api/workspaces',
        { name: 'W', agent_profile_id: memberProfile },
        adminCookie,
      ),
    );
    expect(create.status).toBe(404);

    const jid = await createWorkspaceViaApi(app, adminCookie, 'W');
    const patch = await app.request(
      `/api/workspaces/${jid}`,
      jsonRequest(
        `/api/workspaces/${jid}`,
        { agent_profile_id: memberProfile },
        adminCookie,
        'PATCH',
      ),
    );
    expect(patch.status).toBe(404);

    const session = await app.request(
      `/api/workspaces/${jid}/runtime-sessions`,
      jsonRequest(
        `/api/workspaces/${jid}/runtime-sessions`,
        { name: 'S', agent_profile_id: memberProfile },
        adminCookie,
      ),
    );
    expect(session.status).toBe(404);
  });

  it('workspace delete requires unbind confirmation and cascades sessions and mounts', async () => {
    adminCookie = await setupAdmin(app);
    const jid = await createWorkspaceViaApi(app, adminCookie, 'Cascade');
    const sid = await createSession(app, adminCookie, jid);

    const groupBind = await app.request(
      `/api/workspaces/${jid}/im-binding`,
      putJson(
        `/api/workspaces/${jid}/im-binding`,
        { im_jid: 'g:cascade', channel_type: 'group' },
        adminCookie,
      ),
    );
    expect(groupBind.status).toBe(201);
    const sessionBind = await app.request(
      `/api/workspaces/${jid}/runtime-sessions/${sid}/im-binding`,
      putJson(
        `/api/workspaces/${jid}/runtime-sessions/${sid}/im-binding`,
        { im_jid: 'p:cascade', channel_type: 'private' },
        adminCookie,
      ),
    );
    expect(sessionBind.status).toBe(201);

    const blocked = await app.request(
      `/api/workspaces/${jid}`,
      { method: 'DELETE', ...cookieRequest(adminCookie) },
    );
    expect(blocked.status).toBe(409);
    const blockedBody = (await blocked.json()) as {
      requires_unbind_confirmation?: boolean;
      channel_mount_count?: number;
    };
    expect(blockedBody.requires_unbind_confirmation).toBe(true);
    expect(blockedBody.channel_mount_count).toBe(2);

    const confirmed = await app.request(
      `/api/workspaces/${jid}?unbind_channels=true`,
      { method: 'DELETE', ...cookieRequest(adminCookie) },
    );
    expect(confirmed.status).toBe(200);

    const sessionsAfter = await app.request(
      `/api/workspaces/${jid}/runtime-sessions`,
      cookieRequest(adminCookie),
    );
    expect(sessionsAfter.status).toBe(404);
    const workspaceAfter = await app.request(
      `/api/workspaces/${jid}`,
      cookieRequest(adminCookie),
    );
    expect(workspaceAfter.status).toBe(404);
  });

  it('runtime session create, list, archive and ownership isolation', async () => {
    adminCookie = await setupAdmin(app);
    const jid = await createWorkspaceViaApi(app, adminCookie, 'W');
    const sid = await createSession(app, adminCookie, jid);

    const list = await app.request(
      `/api/workspaces/${jid}/runtime-sessions`,
      cookieRequest(adminCookie),
    );
    const listBody = (await list.json()) as { sessions: unknown[] };
    expect(listBody.sessions.length).toBe(1);

    const archived = await app.request(
      `/api/workspaces/${jid}/runtime-sessions/${sid}`,
      { method: 'DELETE', ...cookieRequest(adminCookie) },
    );
    expect(archived.status).toBe(200);

    const memberCookie = await registerMember(app, 'member');
    const cross = await app.request(
      `/api/workspaces/${jid}/runtime-sessions`,
      cookieRequest(memberCookie),
    );
    expect(cross.status).toBe(404);
  });

  it('channel accounts CRUD, default workspace and ownership 404', async () => {
    adminCookie = await setupAdmin(app);
    const jid = await createWorkspaceViaApi(app, adminCookie, 'W');
    const created = await app.request(
      '/api/channel-accounts',
      jsonRequest(
        '/api/channel-accounts',
        { provider: 'telegram', name: 'Bot', default_workspace_jid: jid },
        adminCookie,
      ),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      channel_account: { id: string; default_workspace_jid: string | null };
    };
    expect(body.channel_account.default_workspace_jid).toBe(jid);

    const patched = await app.request(
      `/api/channel-accounts/${body.channel_account.id}`,
      jsonRequest(
        `/api/channel-accounts/${body.channel_account.id}`,
        { enabled: false },
        adminCookie,
        'PATCH',
      ),
    );
    expect(patched.status).toBe(200);

    const memberCookie = await registerMember(app, 'member');
    const cross = await app.request(
      `/api/channel-accounts/${body.channel_account.id}`,
      cookieRequest(memberCookie),
    );
    expect(cross.status).toBe(404);

    const del = await app.request(
      `/api/channel-accounts/${body.channel_account.id}`,
      { method: 'DELETE', ...cookieRequest(adminCookie) },
    );
    expect(del.status).toBe(200);
  });

  it('enforces binding boundaries: workspace=group only, session=private only', async () => {
    adminCookie = await setupAdmin(app);
    const jid = await createWorkspaceViaApi(app, adminCookie, 'W');

    const groupBind = await app.request(
      `/api/workspaces/${jid}/im-binding`,
      putJson(
        `/api/workspaces/${jid}/im-binding`,
        { im_jid: 'g:123', channel_type: 'group' },
        adminCookie,
      ),
    );
    expect(groupBind.status).toBe(201);

    const privateToWorkspace = await app.request(
      `/api/workspaces/${jid}/im-binding`,
      putJson(
        `/api/workspaces/${jid}/im-binding`,
        { im_jid: 'p:456', channel_type: 'private' },
        adminCookie,
      ),
    );
    expect(privateToWorkspace.status).toBe(400);

    const sid = await createSession(app, adminCookie, jid);
    const sessionPrivate = await app.request(
      `/api/workspaces/${jid}/runtime-sessions/${sid}/im-binding`,
      putJson(
        `/api/workspaces/${jid}/runtime-sessions/${sid}/im-binding`,
        { im_jid: 'p:789', channel_type: 'private' },
        adminCookie,
      ),
    );
    expect(sessionPrivate.status).toBe(201);

    const groupToSession = await app.request(
      `/api/workspaces/${jid}/runtime-sessions/${sid}/im-binding`,
      putJson(
        `/api/workspaces/${jid}/runtime-sessions/${sid}/im-binding`,
        { im_jid: 'g:999', channel_type: 'group' },
        adminCookie,
      ),
    );
    expect(groupToSession.status).toBe(400);
  });

  it('promotes a replacement default channel account after deleting the default', async () => {
    adminCookie = await setupAdmin(app);
    const createdA = await app.request(
      '/api/channel-accounts',
      jsonRequest(
        '/api/channel-accounts',
        { provider: 'telegram', name: 'A', is_default: true },
        adminCookie,
      ),
    );
    expect(createdA.status).toBe(201);
    const createdB = await app.request(
      '/api/channel-accounts',
      jsonRequest(
        '/api/channel-accounts',
        { provider: 'telegram', name: 'B', is_default: true },
        adminCookie,
      ),
    );
    expect(createdB.status).toBe(201);

    const list = (await (
      await app.request('/api/channel-accounts', cookieRequest(adminCookie))
    ).json()) as {
      channel_accounts: Array<{ id: string; name: string; is_default: boolean }>;
    };
    const b = list.channel_accounts.find((a) => a.name === 'B')!;
    expect(b.is_default).toBe(true);

    const del = await app.request(
      `/api/channel-accounts/${b.id}`,
      { method: 'DELETE', ...cookieRequest(adminCookie) },
    );
    expect(del.status).toBe(200);

    const after = (await (
      await app.request('/api/channel-accounts', cookieRequest(adminCookie))
    ).json()) as {
      channel_accounts: Array<{ id: string; name: string; is_default: boolean }>;
    };
    const a = after.channel_accounts.find((item) => item.name === 'A')!;
    expect(a.is_default).toBe(true);
  });

  it('admin does not bypass workspace ownership isolation', async () => {
    adminCookie = await setupAdmin(app);
    const memberCookie = await registerMember(app, 'member');
    const jid = await createWorkspaceViaApi(app, memberCookie, 'MemberWs');
    const adminRead = await app.request(`/api/workspaces/${jid}`, cookieRequest(adminCookie));
    expect(adminRead.status).toBe(404);
    const adminList = await app.request('/api/workspaces', cookieRequest(adminCookie));
    const list = (await adminList.json()) as { workspaces: unknown[] };
    expect(list.workspaces.length).toBe(0);
  });
});
