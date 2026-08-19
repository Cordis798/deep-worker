import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Exported so migration tests can assert "an old database reaches head"
 * without restating the number.
 */
export const CURRENT_SCHEMA_VERSION = 2;

export class MigrationError extends Error {}

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

function createBootstrap(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS config_kv (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function createRuntimeFlags(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_flags (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'bootstrap_meta_tables', up: createBootstrap },
  { version: 2, name: 'runtime_flags', up: createRuntimeFlags },
];

function tableExists(db: Database.Database, name: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
}

export function readSchemaVersion(db: Database.Database): number {
  if (!tableExists(db, 'config_kv')) return 0;
  const row = db
    .prepare('SELECT value FROM config_kv WHERE key = ?')
    .get('schema_version') as { value?: string } | undefined;
  if (!row || row.value == null) return 0;
  const version = Number(row.value);
  return Number.isInteger(version) && version >= 0 ? version : -1;
}

function writeSchemaVersion(db: Database.Database, version: number): void {
  db.prepare(
    `INSERT INTO config_kv (key, value, updated_at)
     VALUES ('schema_version', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(String(version));
}

function sqliteStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Create a self-contained, consistent snapshot before upgrading an existing
 * database. VACUUM INTO reads through SQLite's transaction layer, so committed
 * WAL pages are captured. The snapshot is probed with quick_check before use.
 */
export function createPreMigrationBackup(
  db: Database.Database,
  dbPath: string,
  fromVersion: number,
): string {
  const configuredDir = process.env.DEEP_WORKER_MIGRATION_BACKUP_DIR;
  const backupDir = configuredDir
    ? path.resolve(configuredDir)
    : path.join(path.dirname(dbPath), 'migration-backups');
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const backupPath = path.join(
    backupDir,
    `deep-worker-v${fromVersion}-to-v${CURRENT_SCHEMA_VERSION}-${timestamp}-${process.pid}.db`,
  );
  fs.mkdirSync(backupDir, { recursive: true });
  db.exec(`VACUUM INTO ${sqliteStringLiteral(backupPath)}`);
  const probe = new Database(backupPath);
  const result = probe.pragma('quick_check', { simple: true });
  probe.close();
  if (result !== 'ok') {
    fs.rmSync(backupPath, { force: true });
    throw new Error(`pre-migration backup quick_check returned ${String(result)}`);
  }
  fs.chmodSync(backupPath, 0o600);
  return backupPath;
}

export interface InitDatabaseOptions {
  /** Apply migrations only up to this version (used by migration tests). */
  targetVersion?: number;
}

export function initDatabase(
  dbPath: string,
  options: InitDatabaseOptions = {},
): Database.Database {
  const targetVersion = options.targetVersion ?? CURRENT_SCHEMA_VERSION;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  const current = readSchemaVersion(db);
  if (current < 0) {
    db.close();
    throw new MigrationError(`Invalid database schema version: ${current}`);
  }
  if (current > CURRENT_SCHEMA_VERSION) {
    db.close();
    throw new MigrationError(
      `Database schema v${current} is newer than supported v${CURRENT_SCHEMA_VERSION}; refusing downgrade`,
    );
  }
  if (current > 0 && current < CURRENT_SCHEMA_VERSION) {
    createPreMigrationBackup(db, dbPath, current);
  }
  if (current < targetVersion) {
    db.transaction(() => {
      for (const migration of MIGRATIONS) {
        if (migration.version <= current || migration.version > targetVersion) {
          continue;
        }
        migration.up(db);
        writeSchemaVersion(db, migration.version);
        db.prepare(
          `INSERT OR IGNORE INTO schema_migrations (version, name)
           VALUES (?, ?)`,
        ).run(migration.version, migration.name);
      }
    })();
  }
  if (readSchemaVersion(db) !== targetVersion) {
    db.close();
    throw new Error(
      `schema migration did not reach v${targetVersion} (head v${CURRENT_SCHEMA_VERSION})`,
    );
  }
  return db;
}
