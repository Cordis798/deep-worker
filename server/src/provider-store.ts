import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { decryptChannelCredentials, encryptChannelCredentials } from './channel-secrets.js';
import type { ProviderBalanceConfig } from './provider-pool.js';

export type Db = Database.Database;

export interface ProviderConfigRow {
  id: string;
  owner_user_id: string;
  name: string;
  provider: string;
  model_id: string;
  base_url: string | null;
  secret_ref: string;
  enabled: number;
  weight: number;
  created_at: string;
  updated_at: string;
}

export interface ProviderConfigInput {
  name: string;
  provider: string;
  modelId: string;
  baseUrl?: string | null;
  credentials?: Record<string, unknown>;
  enabled?: boolean;
  weight?: number;
}

function normalizeWeight(weight: number | undefined): number {
  if (weight === undefined) return 1;
  if (!Number.isInteger(weight) || weight < 1 || weight > 100) throw new Error('Provider 权重必须是 1 到 100 的整数');
  return weight;
}

function normalizeRequired(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160) throw new Error(`${field}不能为空且不能超过 160 个字符`);
  return normalized;
}

export function listProviderConfigs(db: Db, ownerUserId: string): ProviderConfigRow[] {
  return db.prepare('SELECT * FROM provider_configs WHERE owner_user_id = ? ORDER BY created_at ASC').all(ownerUserId) as ProviderConfigRow[];
}

export function getProviderConfig(db: Db, ownerUserId: string, id: string): ProviderConfigRow | undefined {
  return db.prepare('SELECT * FROM provider_configs WHERE owner_user_id = ? AND id = ?').get(ownerUserId, id) as ProviderConfigRow | undefined;
}

export function createProviderConfig(db: Db, ownerUserId: string, input: ProviderConfigInput): ProviderConfigRow {
  const now = new Date().toISOString();
  const id = `provider_${crypto.randomUUID()}`;
  const name = normalizeRequired(input.name, 'Provider 名称');
  const provider = normalizeRequired(input.provider, 'Provider 标识');
  const modelId = normalizeRequired(input.modelId, '模型标识');
  db.prepare(
    `INSERT INTO provider_configs
      (id, owner_user_id, name, provider, model_id, base_url, secret_ref, enabled, weight, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, ownerUserId, name, provider, modelId, input.baseUrl?.trim() || null,
    input.credentials ? encryptChannelCredentials(input.credentials) : '', input.enabled === false ? 0 : 1,
    normalizeWeight(input.weight), now, now);
  return getProviderConfig(db, ownerUserId, id)!;
}

export function updateProviderConfig(db: Db, ownerUserId: string, id: string, input: Partial<ProviderConfigInput>): ProviderConfigRow | undefined {
  const current = getProviderConfig(db, ownerUserId, id);
  if (!current) return undefined;
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.name !== undefined) { sets.push('name = ?'); params.push(normalizeRequired(input.name, 'Provider 名称')); }
  if (input.provider !== undefined) { sets.push('provider = ?'); params.push(normalizeRequired(input.provider, 'Provider 标识')); }
  if (input.modelId !== undefined) { sets.push('model_id = ?'); params.push(normalizeRequired(input.modelId, '模型标识')); }
  if (input.baseUrl !== undefined) { sets.push('base_url = ?'); params.push(input.baseUrl?.trim() || null); }
  if (input.credentials !== undefined) { sets.push('secret_ref = ?'); params.push(encryptChannelCredentials(input.credentials)); }
  if (input.enabled !== undefined) { sets.push('enabled = ?'); params.push(input.enabled ? 1 : 0); }
  if (input.weight !== undefined) { sets.push('weight = ?'); params.push(normalizeWeight(input.weight)); }
  if (!sets.length) return current;
  params.push(new Date().toISOString(), id, ownerUserId);
  db.prepare(`UPDATE provider_configs SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND owner_user_id = ?`).run(...params);
  return getProviderConfig(db, ownerUserId, id);
}

export function deleteProviderConfig(db: Db, ownerUserId: string, id: string): boolean {
  return db.prepare('DELETE FROM provider_configs WHERE id = ? AND owner_user_id = ?').run(id, ownerUserId).changes === 1;
}

export function getProviderCredentials(db: Db, ownerUserId: string, id: string): Record<string, unknown> {
  const row = getProviderConfig(db, ownerUserId, id);
  if (!row?.secret_ref) return {};
  return decryptChannelCredentials(row.secret_ref);
}

export function toProviderPublic(row: ProviderConfigRow) {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    model_id: row.model_id,
    base_url: row.base_url,
    enabled: row.enabled === 1,
    weight: row.weight,
    has_secret: row.secret_ref.startsWith('v1.'),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const DEFAULT_BALANCE: ProviderBalanceConfig = {
  strategy: 'round-robin',
  unhealthyThreshold: 2,
  recoveryIntervalMs: 60_000,
};

export function getProviderBalance(db: Db, ownerUserId: string): ProviderBalanceConfig {
  const row = db.prepare('SELECT value FROM config_kv WHERE key = ?').get(`provider_balance:${ownerUserId}`) as { value?: string } | undefined;
  if (!row?.value) return { ...DEFAULT_BALANCE };
  try {
    const parsed = JSON.parse(row.value) as Partial<ProviderBalanceConfig>;
    return {
      strategy: parsed.strategy === 'weighted' || parsed.strategy === 'failover' ? parsed.strategy : 'round-robin',
      unhealthyThreshold: Number.isInteger(parsed.unhealthyThreshold) ? Math.max(1, parsed.unhealthyThreshold!) : DEFAULT_BALANCE.unhealthyThreshold,
      recoveryIntervalMs: Number.isInteger(parsed.recoveryIntervalMs) ? Math.max(1_000, parsed.recoveryIntervalMs!) : DEFAULT_BALANCE.recoveryIntervalMs,
    };
  } catch {
    return { ...DEFAULT_BALANCE };
  }
}

export function setProviderBalance(db: Db, ownerUserId: string, balance: ProviderBalanceConfig): ProviderBalanceConfig {
  const normalized = {
    strategy: balance.strategy,
    unhealthyThreshold: Math.max(1, Math.floor(balance.unhealthyThreshold)),
    recoveryIntervalMs: Math.max(1_000, Math.floor(balance.recoveryIntervalMs)),
  } satisfies ProviderBalanceConfig;
  db.prepare(
    `INSERT INTO config_kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(`provider_balance:${ownerUserId}`, JSON.stringify(normalized));
  return normalized;
}
