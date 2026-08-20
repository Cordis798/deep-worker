import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { decryptChannelCredentials, encryptChannelCredentials } from './channel-secrets.js';
import { getOwnedWorkspace } from './workspaces.js';

export type Db = Database.Database;

export interface ChannelAccountRow {
  id: string;
  owner_user_id: string;
  provider: string;
  name: string;
  secret_ref: string;
  enabled: number;
  is_default: number;
  default_workspace_jid: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

const PROVIDERS = [
  'feishu',
  'telegram',
  'qq',
  'dingtalk',
  'wechat',
  'discord',
  'whatsapp',
] as const;

export type ChannelProvider = (typeof PROVIDERS)[number];

export function isChannelProvider(value: string): value is ChannelProvider {
  return (PROVIDERS as readonly string[]).includes(value);
}

export function generateChannelAccountId(): string {
  return `ca_${crypto.randomUUID()}`;
}

export function getChannelAccountById(
  db: Db,
  id: string,
): ChannelAccountRow | undefined {
  return db
    .prepare('SELECT * FROM channel_accounts WHERE id = ?')
    .get(id) as ChannelAccountRow | undefined;
}

export function getOwnedChannelAccount(
  db: Db,
  ownerUserId: string,
  id: string,
): ChannelAccountRow | undefined {
  return db
    .prepare('SELECT * FROM channel_accounts WHERE id = ? AND owner_user_id = ?')
    .get(id, ownerUserId) as ChannelAccountRow | undefined;
}

export function listOwnedChannelAccounts(
  db: Db,
  ownerUserId: string,
): ChannelAccountRow[] {
  return db
    .prepare(
      'SELECT * FROM channel_accounts WHERE owner_user_id = ? ORDER BY provider, is_default DESC, created_at ASC',
    )
    .all(ownerUserId) as ChannelAccountRow[];
}

export function createChannelAccount(
  db: Db,
  ownerUserId: string,
  fields: {
    provider: string;
    name: string;
    credentials?: Record<string, unknown>;
    is_default?: boolean;
    default_workspace_jid?: string | null;
  },
): { ok: boolean; reason?: 'invalid_provider' | 'invalid_workspace' | 'duplicate' } {
  if (!isChannelProvider(fields.provider)) {
    return { ok: false, reason: 'invalid_provider' };
  }
  if (fields.default_workspace_jid) {
    if (!getOwnedWorkspace(db, ownerUserId, fields.default_workspace_jid)) {
      return { ok: false, reason: 'invalid_workspace' };
    }
  }
  const dup = db
    .prepare(
      'SELECT id FROM channel_accounts WHERE owner_user_id = ? AND provider = ? AND name = ?',
    )
    .get(ownerUserId, fields.provider, fields.name);
  if (dup) return { ok: false, reason: 'duplicate' };

  const now = new Date().toISOString();
  const id = generateChannelAccountId();
  const isDefault = fields.is_default ?? false;
  db.transaction(() => {
    if (isDefault) {
      db.prepare(
        'UPDATE channel_accounts SET is_default = 0 WHERE owner_user_id = ? AND provider = ?',
      ).run(ownerUserId, fields.provider);
    }
    db.prepare(
      `INSERT INTO channel_accounts (
        id, owner_user_id, provider, name, secret_ref, enabled, is_default,
        default_workspace_jid, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      ownerUserId,
      fields.provider,
      fields.name,
      fields.credentials ? encryptChannelCredentials(fields.credentials) : '',
      1,
      isDefault ? 1 : 0,
      fields.default_workspace_jid ?? null,
      'draft',
      now,
      now,
    );
  })();
  return { ok: true };
}

export function updateChannelAccount(
  db: Db,
  ownerUserId: string,
  id: string,
  fields: {
    name?: string;
    enabled?: boolean;
    is_default?: boolean;
    default_workspace_jid?: string | null;
    credentials?: Record<string, unknown>;
  },
): { ok: boolean; reason?: 'not_found' | 'invalid_workspace' } {
  const row = getOwnedChannelAccount(db, ownerUserId, id);
  if (!row) return { ok: false, reason: 'not_found' };
  if (
    fields.default_workspace_jid &&
    !getOwnedWorkspace(db, ownerUserId, fields.default_workspace_jid)
  ) {
    return { ok: false, reason: 'invalid_workspace' };
  }
  db.transaction(() => {
    if (fields.is_default) {
      db.prepare(
        'UPDATE channel_accounts SET is_default = 0 WHERE owner_user_id = ? AND provider = ?',
      ).run(ownerUserId, row.provider);
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.name !== undefined) {
      sets.push('name = ?');
      params.push(fields.name);
    }
    if (fields.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(fields.enabled ? 1 : 0);
    }
    if (fields.is_default !== undefined) {
      sets.push('is_default = ?');
      params.push(fields.is_default ? 1 : 0);
    }
    if (fields.default_workspace_jid !== undefined) {
      sets.push('default_workspace_jid = ?');
      params.push(fields.default_workspace_jid);
    }
    if (fields.credentials !== undefined) {
      sets.push('secret_ref = ?');
      params.push(encryptChannelCredentials(fields.credentials));
    }
    if (sets.length === 0) return;
    params.push(new Date().toISOString(), id, ownerUserId);
    db.prepare(
      `UPDATE channel_accounts SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND owner_user_id = ?`,
    ).run(...params);
  })();
  return { ok: true };
}

export function getChannelAccountCredentials(
  db: Db,
  ownerUserId: string,
  id: string,
): Record<string, unknown> | undefined {
  const row = getOwnedChannelAccount(db, ownerUserId, id);
  if (!row?.secret_ref || !row.secret_ref.startsWith('v1.')) return undefined;
  return decryptChannelCredentials(row.secret_ref);
}

export function deleteChannelAccount(
  db: Db,
  ownerUserId: string,
  id: string,
): boolean {
  return db.transaction(() => {
    const current = getOwnedChannelAccount(db, ownerUserId, id);
    if (!current) return false;
    const result = db
      .prepare('DELETE FROM channel_accounts WHERE id = ? AND owner_user_id = ?')
      .run(id, ownerUserId);
    if (result.changes > 0 && current.is_default === 1) {
      const replacement = db
        .prepare(
          'SELECT id FROM channel_accounts WHERE owner_user_id = ? AND provider = ? ORDER BY created_at ASC LIMIT 1',
        )
        .get(ownerUserId, current.provider) as { id: string } | undefined;
      if (replacement) {
        db.prepare(
          'UPDATE channel_accounts SET is_default = 1, updated_at = ? WHERE id = ?',
        ).run(new Date().toISOString(), replacement.id);
      }
    }
    return result.changes > 0;
  })();
}

export function toChannelAccountPublic(row: ChannelAccountRow) {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    enabled: row.enabled === 1,
    is_default: row.is_default === 1,
    default_workspace_jid: row.default_workspace_jid,
    status: row.status,
    has_secret: row.secret_ref.startsWith('v1.'),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
