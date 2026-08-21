import { describe, expect, it } from 'vitest';
import { FakePiRunner } from '@deep-worker/pi-runner';
import { createApp } from '../app.js';
import { initDatabase } from '../db/migration.js';
import { cookieValue, jsonRequest } from '../helpers/test-app.js';

describe('Provider 路由', () => {
  it('凭据不回传，部分更新不会清空其他配置', async () => {
    const app = createApp({ db: initDatabase(':memory:'), runner: new FakePiRunner() });
    const setup = await app.request('/api/auth/setup', jsonRequest('/api/auth/setup', { username: 'admin', password: 'password123' }));
    const cookie = `dw_session=${cookieValue(setup)}`;
    const created = await app.request('/api/providers', {
      method: 'POST',
      headers: { ...jsonRequest('/api/providers', {}).headers, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '主 Provider', provider: 'openai', model_id: 'gpt-test', credentials: { apiKey: 'secret-value' } }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { provider: { id: string; has_secret: boolean; model_id: string } };
    expect(createdBody.provider.has_secret).toBe(true);
    expect(JSON.stringify(createdBody)).not.toContain('secret-value');
    const updated = await app.request(`/api/providers/${createdBody.provider.id}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json() as { provider: { model_id: string; enabled: boolean; has_secret: boolean } };
    expect(updatedBody.provider.model_id).toBe('gpt-test');
    expect(updatedBody.provider.enabled).toBe(false);
    expect(updatedBody.provider.has_secret).toBe(true);
    await app.close();
  });
});
