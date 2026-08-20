import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

export interface PluginRow {
  id: string;
  owner_user_id: string | null;
  name: string;
  version: string;
  source: string;
  manifest: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

function toPlugin(row: Record<string, unknown>): PluginRow {
  return { ...row, manifest: JSON.parse(String(row.manifest_json)), enabled: row.enabled === 1 } as PluginRow;
}

export function upsertPlugin(db: Database.Database, input: { ownerUserId?: string | null; name: string; version: string; source: string; manifest: Record<string, unknown>; enabled?: boolean }): PluginRow {
  const id = `plugin_${crypto.randomUUID()}`;
  const timestamp = new Date().toISOString();
  const current = db.prepare('SELECT id FROM plugins_catalog WHERE owner_user_id IS ? AND name = ?').get(input.ownerUserId ?? null, input.name) as { id?: string } | undefined;
  if (current?.id) {
    db.prepare('UPDATE plugins_catalog SET version = ?, source = ?, manifest_json = ?, enabled = ?, updated_at = ? WHERE id = ?').run(input.version, input.source, JSON.stringify(input.manifest), input.enabled ? 1 : 0, timestamp, current.id);
    return getPlugin(db, input.ownerUserId ?? null, current.id)!;
  }
  db.prepare('INSERT INTO plugins_catalog (id, owner_user_id, name, version, source, manifest_json, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, input.ownerUserId ?? null, input.name, input.version, input.source, JSON.stringify(input.manifest), input.enabled ? 1 : 0, timestamp, timestamp);
  return getPlugin(db, input.ownerUserId ?? null, id)!;
}

export function getPlugin(db: Database.Database, ownerUserId: string | null, id: string): PluginRow | undefined {
  const row = db.prepare('SELECT * FROM plugins_catalog WHERE id = ? AND owner_user_id IS ?').get(id, ownerUserId) as Record<string, unknown> | undefined;
  return row ? toPlugin(row) : undefined;
}

export function listPlugins(db: Database.Database, ownerUserId: string): PluginRow[] {
  const rows = db.prepare('SELECT * FROM plugins_catalog WHERE owner_user_id IS NULL OR owner_user_id = ? ORDER BY name').all(ownerUserId) as Array<Record<string, unknown>>;
  return rows.map(toPlugin);
}

export function setPluginEnabled(db: Database.Database, ownerUserId: string, id: string, enabled: boolean): boolean {
  return db.prepare('UPDATE plugins_catalog SET enabled = ?, updated_at = ? WHERE id = ? AND (owner_user_id IS NULL OR owner_user_id = ?)').run(enabled ? 1 : 0, new Date().toISOString(), id, ownerUserId).changes === 1;
}
