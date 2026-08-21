import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * 导出当前版本，迁移测试可以据此确认旧数据库已经升级到最新版本，
 * 不必在测试中重复维护版本号。
 */
export const CURRENT_SCHEMA_VERSION = 8;

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

function createChannelReliabilityTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_outbox (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      channel_account_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      source_message_id TEXT,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delivered_at TEXT,
      FOREIGN KEY (owner_user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_channel_outbox_ready
      ON channel_outbox(status, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_channel_outbox_account
      ON channel_outbox(channel_account_id, status);
  `);
}

function createCapabilityTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT,
      scope TEXT NOT NULL,
      project_key TEXT,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      version TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      install_path TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      dependencies_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_skills_scope_owner
      ON skills(scope, owner_user_id, project_key, name);

    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      transport TEXT NOT NULL,
      config_encrypted TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'unknown',
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_user_id, name),
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_servers_owner_status
      ON mcp_servers(owner_user_id, enabled, status);

    CREATE TABLE IF NOT EXISTS plugins_catalog (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      source TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_user_id, name),
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_plugins_catalog_owner_enabled
      ON plugins_catalog(owner_user_id, enabled, name);

    CREATE TABLE IF NOT EXISTS agent_builder_drafts (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      workspace_jid TEXT,
      target_agent_profile_id TEXT,
      title TEXT NOT NULL,
      transcript_json TEXT NOT NULL DEFAULT '[]',
      definition_json TEXT NOT NULL,
      capability_json TEXT NOT NULL DEFAULT '{}',
      preview_hash TEXT,
      confirmation_hash TEXT,
      confirmation_expires_at TEXT,
      prepared_action_id TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_jid) REFERENCES workspaces(jid) ON DELETE SET NULL,
      FOREIGN KEY (target_agent_profile_id) REFERENCES agent_profiles(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_builder_drafts_owner_status
      ON agent_builder_drafts(owner_user_id, status, updated_at DESC);
  `);
}

function createTaskMemoryTables(db: Database.Database): void {
  db.exec(`
    ALTER TABLE workspaces ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'host';

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      name TEXT NOT NULL,
      execution_type TEXT NOT NULL CHECK (execution_type IN ('agent', 'script')),
      schedule_type TEXT NOT NULL CHECK (schedule_type IN ('cron', 'interval', 'once')),
      schedule_value TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      script_command TEXT,
      context_mode TEXT NOT NULL DEFAULT 'isolated' CHECK (context_mode IN ('group', 'isolated')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'deleted')),
      next_run_at TEXT,
      last_run_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_jid) REFERENCES workspaces(jid) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
      ON scheduled_tasks(status, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_owner
      ON scheduled_tasks(owner_user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      idempotency_key TEXT,
      occurrence_key TEXT NOT NULL UNIQUE,
      trigger_type TEXT NOT NULL CHECK (trigger_type IN ('scheduled', 'manual', 'recovery')),
      scheduled_for TEXT NOT NULL,
      definition_snapshot TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'missed', 'stopped')),
      attempt INTEGER NOT NULL DEFAULT 0,
      retry_available_at TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      duration_ms INTEGER,
      result_text TEXT,
      error TEXT,
      notification_status TEXT NOT NULL DEFAULT 'pending' CHECK (notification_status IN ('pending', 'delivered', 'failed', 'skipped')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_idempotency
      ON task_runs(task_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_task_runs_ready
      ON task_runs(status, lease_expires_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_task_runs_task
      ON task_runs(task_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS task_notifications (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      last_error TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES task_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_task_notifications_ready
      ON task_notifications(status, next_attempt_at);

    CREATE TABLE IF NOT EXISTS workspace_memories (
      id TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('fact', 'decision', 'experience', 'follow_up')),
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'web_user',
      revision INTEGER NOT NULL DEFAULT 1,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      FOREIGN KEY (workspace_jid) REFERENCES workspaces(jid) ON DELETE CASCADE,
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_memories_scope
      ON workspace_memories(workspace_jid, deleted_at, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workspace_memories_kind
      ON workspace_memories(workspace_jid, kind, deleted_at);

    CREATE TABLE IF NOT EXISTS memory_revisions (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(memory_id, revision),
      FOREIGN KEY (memory_id) REFERENCES workspace_memories(id) ON DELETE CASCADE,
      FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_memory_revisions_memory
      ON memory_revisions(memory_id, revision DESC);
  `);
}

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'bootstrap_meta_tables', up: createBootstrap },
  { version: 2, name: 'runtime_flags', up: createRuntimeFlags },
  { version: 3, name: 'auth_tables', up: createAuthTables },
  { version: 4, name: 'domain_tables', up: createDomainTables },
  { version: 5, name: 'runner_reliability_tables', up: createRunnerReliabilityTables },
  { version: 6, name: 'channel_reliability_tables', up: createChannelReliabilityTables },
  { version: 7, name: 'capability_tables', up: createCapabilityTables },
  { version: 8, name: 'task_memory_tables', up: createTaskMemoryTables },
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
