import { describe, expect, it } from 'vitest';
import { FakePiRunner } from '@deep-worker/pi-runner';
import { createApp, type App } from '../app.js';
import { initDatabase } from '../db/migration.js';
import { cookieValue, jsonRequest } from '../helpers/test-app.js';

async function setupWorkspace(app: App) {
  const setup = await app.request(
    '/api/auth/setup',
    jsonRequest('/api/auth/setup', { username: 'admin', password: 'password123' }),
  );
  const cookie = cookieValue(setup);
  const workspace = await app.request(
    '/api/workspaces',
    jsonRequest('/api/workspaces', { name: '工具测试工作区' }, cookie),
  );
  const body = (await workspace.json()) as { workspace: { jid: string } };
  return { cookie, jid: body.workspace.jid };
}

describe('Workspace file routes', () => {
  it('browses, creates, uploads, and reads workspace files', async () => {
    const app = createApp({ db: initDatabase(':memory:'), runner: new FakePiRunner() });
    const { cookie, jid } = await setupWorkspace(app);
    const list = await app.request(`/api/workspaces/${jid}/files`, {
      headers: { cookie: `dw_session=${cookie}` },
    });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { files: unknown[] }).files).toEqual([]);

    const directory = await app.request(
      `/api/workspaces/${jid}/directories`,
      jsonRequest(`/api/workspaces/${jid}/directories`, { path: '', name: 'docs' }, cookie),
    );
    expect(directory.status).toBe(201);

    const form = new FormData();
    form.append('path', 'docs');
    form.append('files', new File(['hello from web'], 'note.txt', { type: 'text/plain' }));
    const upload = await app.request(`/api/workspaces/${jid}/files`, {
      method: 'POST',
      headers: { cookie: `dw_session=${cookie}` },
      body: form,
    });
    expect(upload.status).toBe(201);

    const encoded = Buffer.from('docs/note.txt').toString('base64url');
    const content = await app.request(`/api/workspaces/${jid}/files/content/${encoded}`, {
      headers: { cookie: `dw_session=${cookie}` },
    });
    expect(content.status).toBe(200);
    expect(((await content.json()) as { content: string }).content).toBe('hello from web');
    await app.close();
  });

  it('rejects paths that escape the workspace', async () => {
    const app = createApp({ db: initDatabase(':memory:'), runner: new FakePiRunner() });
    const { cookie, jid } = await setupWorkspace(app);
    const response = await app.request(`/api/workspaces/${jid}/files?path=..%2Foutside`, {
      headers: { cookie: `dw_session=${cookie}` },
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('工作区');
    await app.close();
  });
});
