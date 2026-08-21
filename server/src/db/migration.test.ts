import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  CURRENT_SCHEMA_VERSION,
  initDatabase,
  MigrationError,
  readSchemaVersion,
} from './migration.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-mig-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('sqlite migration framework', () => {
  it('initializes a fresh database to head', () => {
    const dbPath = path.join(dir, 'deep-worker.db');
    const db = initDatabase(dbPath);
    expect(readSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'")
        .get(),
    ).toBeTruthy();
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get(),
    ).toBeTruthy();
    expect(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_profiles'")
        .get(),
    ).toBeTruthy();
    expect(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'")
        .get(),
    ).toBeTruthy();
    expect(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_accounts'",
        )
        .get(),
    ).toBeTruthy();
    expect(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_profile_prompt_versions'",
        )
        .get(),
    ).toBeTruthy();
    expect(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_sessions'",
        )
        .get(),
    ).toBeTruthy();
    expect(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_mounts'")
        .get(),
    ).toBeTruthy();
    expect(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_channel_mounts'",
        )
        .get(),
    ).toBeTruthy();
    expect(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'im_context_bindings'",
        )
        .get(),
    ).toBeTruthy();
    expect(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runner_inbox'")
        .get(),
    ).toBeTruthy();
    expect(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runner_turns'")
        .get(),
    ).toBeTruthy();
    expect(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runner_outbox'")
        .get(),
    ).toBeTruthy();
    for (const table of [
      'skills', 'mcp_servers', 'plugins_catalog', 'agent_builder_drafts',
      'scheduled_tasks', 'task_runs', 'task_notifications',
      'workspace_memories', 'memory_revisions',
    ]) {
      expect(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
      ).toBeTruthy();
    }
    expect(
      db.prepare("SELECT 1 FROM pragma_table_info('workspaces') WHERE name = 'execution_mode'").get(),
    ).toBeTruthy();
    db.close();
  });

  it('upgrades an old database to head', () => {
    const dbPath = path.join(dir, 'deep-worker.db');
    const old = initDatabase(dbPath, { targetVersion: 1 });
    expect(readSchemaVersion(old)).toBe(1);
    old.close();

    const upgraded = initDatabase(dbPath);
    expect(readSchemaVersion(upgraded)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      upgraded
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_flags'")
        .get(),
    ).toBeTruthy();
    upgraded.close();
  });

  it('refuses to downgrade a database newer than head', () => {
    const dbPath = path.join(dir, 'deep-worker.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE config_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
    db.prepare("INSERT INTO config_kv (key, value) VALUES ('schema_version', ?)").run(
      String(CURRENT_SCHEMA_VERSION + 1),
    );
    db.close();

    expect(() => initDatabase(dbPath)).toThrow(MigrationError);
    expect(() => initDatabase(dbPath)).toThrow(/refusing downgrade/i);
  });

  it('does not create a migration backup for a fresh database', () => {
    const backupDir = path.join(dir, 'backups');
    process.env.DEEP_WORKER_MIGRATION_BACKUP_DIR = backupDir;
    const dbPath = path.join(dir, 'fresh.db');
    const db = initDatabase(dbPath);
    db.close();
    expect(fs.existsSync(backupDir)).toBe(false);
  });

  it('creates a pre-migration backup when upgrading an existing database', () => {
    const backupDir = path.join(dir, 'backups');
    process.env.DEEP_WORKER_MIGRATION_BACKUP_DIR = backupDir;
    const dbPath = path.join(dir, 'upgrade.db');
    const old = initDatabase(dbPath, { targetVersion: 1 });
    old.close();
    const upgraded = initDatabase(dbPath);
    upgraded.close();
    const files = fs.readdirSync(backupDir);
    expect(files.some((file) => file.endsWith('.db'))).toBe(true);
  });
});
