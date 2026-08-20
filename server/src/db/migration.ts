import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * 导出当前版本，迁移测试可以据此确认旧数据库已经升级到最新版本，
 * 不必在测试中重复维护版本号。
 */
export const CURRENT_SCHEMA_VERSION = 5;

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

function createAuthTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'active',
      permissions TEXT NOT NULL DEFAULT '[]',
      must_change_password INTEGER NOT NULL DEFAULT 0,
      disable_reason TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      permissions TEXT NOT NULL DEFAULT '[]',
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS auth_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      username TEXT NOT NULL,
      actor_username TEXT,
      ip_address TEXT,
      user_agent TEXT,
      details TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_auth_audit_created ON auth_audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_users_status_role ON users(status, role);
    CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);
    CREATE INDEX IF NOT EXISTS idx_invites_created_at ON invite_codes(created_at);
  `);
}

function createDomainTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_profiles (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      identity_prompt TEXT NOT NULL DEFAULT '',
      soul_prompt TEXT NOT NULL DEFAULT '',
      agents_prompt TEXT NOT NULL DEFAULT '',
      tools_prompt TEXT NOT NULL DEFAULT '',
      prompt_mode TEXT NOT NULL DEFAULT 'append',
      identity_hash TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (owner_user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_profiles_owner
      ON agent_profiles(owner_user_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_profiles_default
      ON agent_profiles(owner_user_id)
      WHERE is_default = 1 AND status = 'active';

    CREATE TABLE IF NOT EXISTS agent_profile_prompt_versions (
      id TEXT PRIMARY KEY,
      agent_profile_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      identity_prompt TEXT NOT NULL DEFAULT '',
      soul_prompt TEXT NOT NULL DEFAULT '',
      agents_prompt TEXT NOT NULL DEFAULT '',
      tools_prompt TEXT NOT NULL DEFAULT '',
      prompt_mode TEXT NOT NULL DEFAULT 'append',
      identity_hash TEXT NOT NULL DEFAULT '',
      change_source TEXT NOT NULL DEFAULT 'update',
      restored_from_version INTEGER,
      created_at TEXT NOT NULL,
      UNIQUE(agent_profile_id, version),
      FOREIGN KEY (agent_profile_id) REFERENCES agent_profiles(id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_profile_prompt_versions_profile
      ON agent_profile_prompt_versions(agent_profile_id, version DESC);

    CREATE TABLE IF NOT EXISTS workspaces (
      jid TEXT PRIMARY KEY,
      folder TEXT NOT NULL,
      owner_user_id TEXT,
      name TEXT NOT NULL,
      agent_profile_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      is_home INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (owner_user_id) REFERENCES users(id),
      FOREIGN KEY (agent_profile_id) REFERENCES agent_profiles(id)
    );
    CREATE INDEX IF NOT EXISTS idx_workspaces_folder ON workspaces(folder);
    CREATE INDEX IF NOT EXISTS idx_workspaces_owner
      ON workspaces(owner_user_id, status);

    CREATE TABLE IF NOT EXISTS runtime_sessions (
      id TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      agent_profile_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workspace_jid) REFERENCES workspaces(jid) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_sessions_workspace
      ON runtime_sessions(workspace_jid, updated_at DESC);

    CREATE TABLE IF NOT EXISTS channel_accounts (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      name TEXT NOT NULL,
      secret_ref TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      default_workspace_jid TEXT,
      status TEXT NOT NULL DEFAULT 'disconnected',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_user_id, provider, name),
      FOREIGN KEY (owner_user_id) REFERENCES users(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_accounts_one_default
      ON channel_accounts(owner_user_id, provider)
      WHERE is_default = 1;

    CREATE TABLE IF NOT EXISTS channel_mounts (
      im_jid TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      channel_account_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workspace_jid) REFERENCES workspaces(jid) ON DELETE CASCADE,
      FOREIGN KEY (owner_user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_channel_mounts_workspace
      ON channel_mounts(workspace_jid);

    CREATE TABLE IF NOT EXISTS agent_channel_mounts (
      im_jid TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      session_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      channel_account_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workspace_jid) REFERENCES workspaces(jid) ON DELETE CASCADE,
      FOREIGN KEY (owner_user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_channel_mounts_session
      ON agent_channel_mounts(session_id);

    CREATE TABLE IF NOT EXISTS im_context_bindings (
      source_jid TEXT NOT NULL,
      context_type TEXT NOT NULL,
      context_id TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source_jid, context_type, context_id)
    );
    CREATE INDEX IF NOT EXISTS idx_icb_workspace ON im_context_bindings(workspace_jid);
  `);
}

function createRunnerReliabilityTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runner_inbox (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      session_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      message TEXT NOT NULL,
      status TEXT NOT NULL,
      available_at TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (owner_user_id) REFERENCES users(id),
      FOREIGN KEY (workspace_jid) REFERENCES workspaces(jid) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES runtime_sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_runner_inbox_ready
      ON runner_inbox(status, available_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_runner_inbox_session
      ON runner_inbox(session_id, created_at);

    CREATE TABLE IF NOT EXISTS runner_turns (
      id TEXT PRIMARY KEY,
      inbox_id TEXT NOT NULL UNIQUE,
      owner_user_id TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      available_at TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_expires_at TEXT,
      result_text TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (inbox_id) REFERENCES runner_inbox(id) ON DELETE CASCADE,
      FOREIGN KEY (owner_user_id) REFERENCES users(id),
      FOREIGN KEY (workspace_jid) REFERENCES workspaces(jid) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES runtime_sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_runner_turns_ready
      ON runner_turns(status, available_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_runner_turns_session
      ON runner_turns(session_id, status, created_at);

    CREATE TABLE IF NOT EXISTS runner_outbox (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      UNIQUE(turn_id, ordinal),
      FOREIGN KEY (turn_id) REFERENCES runner_turns(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_runner_outbox_pending
      ON runner_outbox(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_runner_outbox_turn
      ON runner_outbox(turn_id, ordinal);
  `);
}

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'bootstrap_meta_tables', up: createBootstrap },
  { version: 2, name: 'runtime_flags', up: createRuntimeFlags },
  { version: 3, name: 'auth_tables', up: createAuthTables },
  { version: 4, name: 'domain_tables', up: createDomainTables },
  { version: 5, name: 'runner_reliability_tables', up: createRunnerReliabilityTables },
];

function tableExists(db: Database.Database, name: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
}

export function readSchemaVersion(db: Database.Database): number {
  if (!tableExists(db, 'config_kv')) return 0;
  const row = db.prepare('SELECT value FROM config_kv WHERE key = ?').get('schema_version') as
    { value?: string } | undefined;
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
 * 升级已有数据库前创建自包含且一致的快照。VACUUM INTO 通过 SQLite 事务层
 * 读取，因此能够包含已提交的 WAL 页面；快照使用前还会执行 quick_check 检查。
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
  /** 只应用到指定版本，供迁移测试构造旧版本数据库。 */
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
