import { describe, expect, it } from 'vitest';
import { initDatabase } from './db/migration.js';
import { createProviderConfig, getProviderCredentials, listProviderConfigs, toProviderPublic } from './provider-store.js';
import { createUser } from './users.js';

describe('Provider 配置存储', () => {
  it('加密凭据并且公共数据不返回密文', () => {
    const db = initDatabase(':memory:');
    createUser(db, { id: 'u', username: 'u', password_hash: 'x', display_name: '用户', role: 'admin', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    const row = createProviderConfig(db, 'u', { name: '主模型', provider: 'openai', modelId: 'gpt-test', credentials: { apiKey: 'secret-value' } });
    expect(listProviderConfigs(db, 'u')).toHaveLength(1);
    expect(row.secret_ref).toMatch(/^v1\./);
    expect(getProviderCredentials(db, 'u', row.id)).toEqual({ apiKey: 'secret-value' });
    expect(JSON.stringify(toProviderPublic(row))).not.toContain('secret-value');
    expect(JSON.stringify(toProviderPublic(row))).not.toContain(row.secret_ref);
    db.close();
  });
});
