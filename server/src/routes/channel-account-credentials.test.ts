import { describe, expect, it } from 'vitest';
import { getChannelAccountCredentials } from '../channel-accounts.js';
import { createApp, type App } from '../app.js';
import { initDatabase } from '../db/migration.js';
import { cookieValue, jsonRequest } from '../helpers/test-app.js';

async function setupAdmin(app: App): Promise<string> {
  const response = await app.request('/api/auth/setup', jsonRequest('/api/auth/setup', { username: 'admin', password: 'password123' }));
  return cookieValue(response);
}

describe('渠道账号凭据接口', () => {
  it('创建账号时只返回凭据存在标记，数据库保存可解密密文', async () => {
    const db = initDatabase(':memory:');
    const app = createApp({ db });
    const cookie = await setupAdmin(app);
    const response = await app.request('/api/channel-accounts', jsonRequest('/api/channel-accounts', { provider: 'telegram', name: '安全账号', credentials: { token: 'do-not-leak' } }, cookie));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { channel_account: { id: string; has_secret: boolean } };
    expect(body.channel_account.has_secret).toBe(true);
    expect(JSON.stringify(body)).not.toContain('do-not-leak');
    const raw = db.prepare('SELECT secret_ref FROM channel_accounts WHERE id = ?').get(body.channel_account.id) as { secret_ref: string };
    expect(raw.secret_ref).toMatch(/^v1\./);
    expect(raw.secret_ref).not.toContain('do-not-leak');
    const user = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
    expect(getChannelAccountCredentials(db, user.id, body.channel_account.id)).toEqual({ token: 'do-not-leak' });
    await app.close();
  });
});
