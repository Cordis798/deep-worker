import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { encryptChannelCredentials, decryptChannelCredentials } from '../channel-secrets.js';
import { HttpMcpTransport, McpClient, StdioMcpTransport, type McpTransport } from './mcp-client.js';

export type McpTransportKind = 'stdio' | 'http';

export interface McpServerConfig {
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  credentials?: Record<string, unknown>;
}

export interface McpServerRow {
  id: string;
  owner_user_id: string;
  name: string;
  transport: McpTransportKind;
  enabled: boolean;
  status: 'unknown' | 'healthy' | 'unhealthy' | 'disabled';
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface McpRuntimeServerRow extends McpServerRow, McpServerConfig {}

function toRow(row: Record<string, unknown>): McpServerRow {
  return { ...row, enabled: row.enabled === 1 } as McpServerRow;
}

export function createMcpServer(db: Database.Database, ownerUserId: string, input: McpServerConfig & { name: string; transport: McpTransportKind }) {
  if (input.transport === 'stdio' && !input.command) throw new Error('stdio MCP 必须提供 command');
  if (input.transport === 'http' && !input.url) throw new Error('HTTP MCP 必须提供 url');
  const id = `mcp_${crypto.randomUUID()}`;
  const timestamp = new Date().toISOString();
  const encryptedConfig = encryptChannelCredentials(input as unknown as Record<string, unknown>);
  db.prepare(`INSERT INTO mcp_servers (id, owner_user_id, name, transport, config_encrypted, enabled, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 'unknown', ?, ?)`).run(id, ownerUserId, input.name.trim(), input.transport, encryptedConfig, timestamp, timestamp);
  return { row: getMcpServer(db, ownerUserId, id)!, encryptedConfig };
}

export function getMcpServer(db: Database.Database, ownerUserId: string, id: string): McpServerRow | undefined {
  const row = db.prepare('SELECT id, owner_user_id, name, transport, enabled, status, last_error, created_at, updated_at FROM mcp_servers WHERE id = ? AND owner_user_id = ?').get(id, ownerUserId) as Record<string, unknown> | undefined;
  return row ? toRow(row) : undefined;
}

function getEncryptedConfig(db: Database.Database, ownerUserId: string, id: string): string | undefined {
  const row = db.prepare('SELECT config_encrypted FROM mcp_servers WHERE id = ? AND owner_user_id = ?').get(id, ownerUserId) as { config_encrypted?: string } | undefined;
  return row?.config_encrypted;
}

export function listMcpServers(db: Database.Database, ownerUserId: string): McpServerRow[] {
  const rows = db.prepare('SELECT id, owner_user_id, name, transport, enabled, status, last_error, created_at, updated_at FROM mcp_servers WHERE owner_user_id = ? ORDER BY name').all(ownerUserId) as Array<Record<string, unknown>>;
  return rows.map(toRow);
}

/** 返回运行时建立 MCP 连接所需的配置；仅供服务端执行链路使用，不用于公开 API。 */
export function listMcpServersForRuntime(db: Database.Database, ownerUserId: string): McpRuntimeServerRow[] {
  const rows = db
    .prepare('SELECT *, config_encrypted FROM mcp_servers WHERE owner_user_id = ? ORDER BY name')
    .all(ownerUserId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    ...toRow(row),
    ...(decryptChannelCredentials(String(row.config_encrypted)) as McpServerConfig),
  }));
}

export function setMcpEnabled(db: Database.Database, ownerUserId: string, id: string, enabled: boolean): boolean {
  return db.prepare("UPDATE mcp_servers SET enabled = ?, status = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?").run(enabled ? 1 : 0, enabled ? 'unknown' : 'disabled', new Date().toISOString(), id, ownerUserId).changes === 1;
}

export function getMcpConfig(db: Database.Database, ownerUserId: string, id: string): McpServerConfig | undefined {
  const encrypted = getEncryptedConfig(db, ownerUserId, id);
  return encrypted ? (decryptChannelCredentials(encrypted) as McpServerConfig) : undefined;
}

export type McpTransportFactory = (row: McpServerRow, config: McpServerConfig) => McpTransport;

function defaultTransportFactory(row: McpServerRow, config: McpServerConfig): McpTransport {
  const credentials = config.credentials ?? {};
  if (row.transport === 'stdio') return new StdioMcpTransport({ command: config.command!, args: config.args, cwd: config.cwd, env: Object.fromEntries(Object.entries(credentials).map(([key, value]) => [key, String(value)])) });
  return new HttpMcpTransport({ url: config.url!, headers: { ...config.headers, ...Object.fromEntries(Object.entries(credentials).map(([key, value]) => [`x-mcp-${key}`, String(value)])) } });
}

export async function healthCheckMcpServer(db: Database.Database, ownerUserId: string, id: string, factory: McpTransportFactory = defaultTransportFactory): Promise<{ ok: boolean; toolCount: number; error?: string }> {
  const row = getMcpServer(db, ownerUserId, id);
  const config = row ? getMcpConfig(db, ownerUserId, id) : undefined;
  if (!row || !config) return { ok: false, toolCount: 0, error: 'MCP Server not found' };
  if (!row.enabled) return { ok: false, toolCount: 0, error: 'MCP Server disabled' };
  const transport = factory(row, config);
  const client = new McpClient(transport);
  try {
    await client.connect();
    const tools = await client.listTools();
    const healthy = await client.healthCheck();
    db.prepare('UPDATE mcp_servers SET status = ?, last_error = NULL, updated_at = ? WHERE id = ? AND owner_user_id = ?').run(healthy ? 'healthy' : 'unhealthy', new Date().toISOString(), id, ownerUserId);
    return { ok: healthy, toolCount: tools.length, ...(healthy ? {} : { error: 'MCP ping 失败' }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare('UPDATE mcp_servers SET status = \'unhealthy\', last_error = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?').run(message.slice(0, 500), new Date().toISOString(), id, ownerUserId);
    return { ok: false, toolCount: 0, error: message };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function healthCheckMcpServers(db: Database.Database, ownerUserId: string, factory?: McpTransportFactory): Promise<void> {
  for (const server of listMcpServers(db, ownerUserId)) await healthCheckMcpServer(db, ownerUserId, server.id, factory);
}
