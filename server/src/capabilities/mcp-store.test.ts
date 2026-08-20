import { afterEach, describe, expect, it } from 'vitest';
import { decryptChannelCredentials } from '../channel-secrets.js';
import { initDatabase } from '../db/migration.js';
import { InMemoryMcpTransport } from './mcp-client.js';
import { createMcpServer, healthCheckMcpServer, listMcpServers, setMcpEnabled } from './mcp-store.js';
import { listPlugins, setPluginEnabled, upsertPlugin } from './plugin-catalog.js';

function user(db: ReturnType<typeof initDatabase>) {
  db.prepare("INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run('user-1', 'mcp-user', 'hash', new Date().toISOString(), new Date().toISOString());
}

describe('MCP 与 Plugins 目录', () => {
  let db: ReturnType<typeof initDatabase> | undefined;

  afterEach(() => db?.close());

  it('加密 MCP 配置并完成健康检查，列表不泄露凭据', async () => {
    db = initDatabase(':memory:');
    user(db);
    const server = createMcpServer(db, 'user-1', { name: 'demo', transport: 'stdio', command: 'demo', credentials: { token: 'secret' } });
    expect(listMcpServers(db, 'user-1')[0]).not.toHaveProperty('config');
    expect((decryptChannelCredentials(server.encryptedConfig).credentials as { token?: string }).token).toBe('secret');
    const transport = new InMemoryMcpTransport({ tools: [{ name: 'echo' }] });
    await expect(healthCheckMcpServer(db, 'user-1', server.row.id, () => transport)).resolves.toMatchObject({ ok: true, toolCount: 1 });
    expect(listMcpServers(db, 'user-1')[0].status).toBe('healthy');
    expect(setMcpEnabled(db, 'user-1', server.row.id, false)).toBe(true);
  });

  it('只保存 Plugins catalog 和启用状态', () => {
    db = initDatabase(':memory:');
    user(db);
    const plugin = upsertPlugin(db, { ownerUserId: 'user-1', name: 'demo', version: '1.0.0', source: 'local', manifest: { description: 'demo' } });
    expect(listPlugins(db, 'user-1')).toEqual([expect.objectContaining({ id: plugin.id, enabled: false, name: 'demo' })]);
    expect(setPluginEnabled(db, 'user-1', plugin.id, true)).toBe(true);
    expect(listPlugins(db, 'user-1')[0].enabled).toBe(true);
  });
});
