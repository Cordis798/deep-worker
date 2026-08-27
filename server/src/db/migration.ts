import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * 导出当前版本，迁移测试可以据此确认旧数据库已经升级到最新版本，
 * 不必在测试中重复维护版本号。
 */
export const CURRENT_SCHEMA_VERSION = 17;

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

function migrateExecutionPolicy(db: Database.Database): void {
  // 历史 Host 工作区只对仍然具备管理员权限的所有者保留。
  db.prepare(
    `UPDATE workspaces SET execution_mode = 'container'
     WHERE execution_mode = 'host' AND (
       owner_user_id IS NULL OR owner_user_id IN (
         SELECT id FROM users WHERE role != 'admin' OR status != 'active' OR deleted_at IS NOT NULL
       )
     )`,
  ).run();
}

function createProviderTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_configs (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      base_url TEXT,
      secret_ref TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      weight INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_user_id, name),
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_provider_configs_owner
      ON provider_configs(owner_user_id, enabled, created_at);
  `);
}

function createUsageBillingTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      tier INTEGER NOT NULL DEFAULT 0,
      monthly_cost_usd REAL NOT NULL DEFAULT 0,
      monthly_token_quota INTEGER,
      monthly_cost_quota REAL,
      daily_token_quota INTEGER,
      daily_cost_quota REAL,
      weekly_token_quota INTEGER,
      weekly_cost_quota REAL,
      rate_multiplier REAL NOT NULL DEFAULT 1,
      trial_days INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      display_price TEXT,
      highlight INTEGER NOT NULL DEFAULT 0,
      max_groups INTEGER,
      max_concurrent_containers INTEGER,
      max_im_channels INTEGER,
      max_mcp_servers INTEGER,
      max_storage_mb INTEGER,
      allow_overage INTEGER NOT NULL DEFAULT 0,
      features_json TEXT NOT NULL DEFAULT '[]',
      is_default INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_plans_default
      ON billing_plans(is_default) WHERE is_default = 1;

    CREATE TABLE IF NOT EXISTS user_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'cancelled', 'expired')),
      started_at TEXT NOT NULL,
      expires_at TEXT,
      cancelled_at TEXT,
      trial_ends_at TEXT,
      notes TEXT,
      auto_renew INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (plan_id) REFERENCES billing_plans(id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_status
      ON user_subscriptions(user_id, status, started_at DESC);

    CREATE TABLE IF NOT EXISTS user_balances (
      user_id TEXT PRIMARY KEY,
      balance_usd REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS balance_transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount_usd REAL NOT NULL,
      balance_after REAL NOT NULL,
      source TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      reference_id TEXT,
      idempotency_key TEXT UNIQUE,
      notes TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_balance_transactions_user_created
      ON balance_transactions(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS monthly_usage (
      user_id TEXT NOT NULL,
      month TEXT NOT NULL,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      total_reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, month),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS daily_usage (
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      total_reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, date),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON daily_usage(date);

    CREATE TABLE IF NOT EXISTS redeem_codes (
      code TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('balance', 'subscription', 'trial')),
      value_usd REAL,
      plan_id TEXT,
      duration_days INTEGER,
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_by TEXT NOT NULL,
      notes TEXT,
      batch_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (plan_id) REFERENCES billing_plans(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS redeem_code_usage (
      code TEXT NOT NULL,
      user_id TEXT NOT NULL,
      used_at TEXT NOT NULL,
      PRIMARY KEY (code, user_id),
      FOREIGN KEY (code) REFERENCES redeem_codes(code) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS billing_audit_log (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      user_id TEXT,
      actor_user_id TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_billing_audit_created
      ON billing_audit_log(created_at DESC);

    CREATE TABLE IF NOT EXISTS usage_events (
      event_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      agent_id TEXT,
      message_id TEXT,
      source TEXT NOT NULL DEFAULT 'agent',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      provider_estimated_cost_usd REAL NOT NULL DEFAULT 0,
      billed_cost_usd REAL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      num_turns INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_jid) REFERENCES workspaces(jid) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_user_created
      ON usage_events(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_events_workspace_created
      ON usage_events(workspace_jid, created_at DESC);

    CREATE TABLE IF NOT EXISTS usage_event_models (
      event_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      provider_estimated_cost_usd REAL NOT NULL DEFAULT 0,
      billed_cost_usd REAL,
      PRIMARY KEY (event_id, model),
      FOREIGN KEY (event_id) REFERENCES usage_events(event_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_usage_event_models_model ON usage_event_models(model);

    CREATE TABLE IF NOT EXISTS usage_daily_summary (
      user_id TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL,
      date TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      provider_estimated_cost_usd REAL NOT NULL DEFAULT 0,
      billed_cost_usd REAL,
      run_count INTEGER NOT NULL DEFAULT 0,
      model_call_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, workspace_jid, agent_id, model, date),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_jid) REFERENCES workspaces(jid) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_usage_daily_summary_user_date
      ON usage_daily_summary(user_id, date);

    INSERT OR IGNORE INTO billing_plans
      (id, name, description, tier, monthly_cost_usd, rate_multiplier, allow_overage, features_json, is_default, is_active, created_at, updated_at)
    VALUES
      ('free', '免费套餐', '默认本地套餐', 0, 0, 1, 1, '[]', 1, 1, datetime('now'), datetime('now'));
  `);
}

function createQuotaOverrideTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_quota_overrides (
      scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'agent', 'workspace')),
      scope_id TEXT NOT NULL,
      daily_token_quota INTEGER,
      daily_cost_quota REAL,
      weekly_token_quota INTEGER,
      weekly_cost_quota REAL,
      monthly_token_quota INTEGER,
      monthly_cost_quota REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope_type, scope_id)
    );
  `);
}

function migrateRuntimeContext(db: Database.Database): void {
  db.exec(`
    ALTER TABLE runtime_sessions ADD COLUMN context_status TEXT NOT NULL DEFAULT 'new'
      CHECK (context_status IN ('new', 'restored', 'reset_required'));
    ALTER TABLE runtime_sessions ADD COLUMN context_generation INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE runtime_sessions ADD COLUMN sdk_session_id TEXT;
    ALTER TABLE runtime_sessions ADD COLUMN context_error TEXT;
    ALTER TABLE runtime_sessions ADD COLUMN source_session_id TEXT;
    ALTER TABLE runtime_sessions ADD COLUMN source_snapshot_hash TEXT;
    CREATE INDEX IF NOT EXISTS idx_runtime_sessions_context
      ON runtime_sessions(workspace_jid, context_status, updated_at DESC);
  `);
}

function migrateWorkspaceMembers(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_jid TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('workspace_admin', 'member', 'viewer')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
      invited_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revoked_at TEXT,
      PRIMARY KEY (workspace_jid, user_id),
      FOREIGN KEY (workspace_jid) REFERENCES workspaces(jid) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (invited_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_members_user
      ON workspace_members(user_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace
      ON workspace_members(workspace_jid, status, role);
  `);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO workspace_members (
      workspace_jid, user_id, role, status, invited_by, created_at, updated_at
    ) SELECT jid, owner_user_id, 'workspace_admin', 'active', owner_user_id, ?, ?
      FROM workspaces WHERE owner_user_id IS NOT NULL`,
  ).run(now, now);
}

function migrateCapabilityGovernance(db: Database.Database): void {
  db.exec(`
    ALTER TABLE workspace_members ADD COLUMN job_role TEXT NOT NULL DEFAULT 'general'
      CHECK (job_role IN ('general', 'engineering', 'operations', 'sales'));
    ALTER TABLE workspace_members ADD COLUMN capability_package TEXT NOT NULL DEFAULT 'general';
    CREATE TABLE IF NOT EXISTS capability_resolution_audit (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      job_role TEXT NOT NULL,
      capability_package TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('allowed', 'denied')),
      manifest_hash TEXT,
      conflicts_json TEXT NOT NULL DEFAULT '[]',
      reason TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_jid) REFERENCES workspaces(jid) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_capability_audit_workspace
      ON capability_resolution_audit(workspace_jid, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_capability_audit_actor
      ON capability_resolution_audit(actor_user_id, created_at DESC);
  `);
}

function migrateAgentRouter(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_agent_bindings (
      id TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL,
      agent_profile_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      capability_json TEXT NOT NULL DEFAULT '[]',
      role_tags_json TEXT NOT NULL DEFAULT '[]',
      priority INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_jid, agent_profile_id),
      FOREIGN KEY (workspace_jid) REFERENCES workspaces(jid) ON DELETE CASCADE,
      FOREIGN KEY (agent_profile_id) REFERENCES agent_profiles(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_agent_bindings_route
      ON workspace_agent_bindings(workspace_jid, enabled, priority DESC);

    CREATE TABLE IF NOT EXISTS agent_router_plans (
      id TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL,
      session_id TEXT,
      actor_user_id TEXT NOT NULL,
      intent TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('planned', 'running', 'completed', 'failed', 'cancelled')),
      input_json TEXT NOT NULL,
      route_json TEXT NOT NULL,
      result_json TEXT,
      capability_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (workspace_jid) REFERENCES workspaces(jid) ON DELETE CASCADE,
      FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES runtime_sessions(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_router_plans_workspace
      ON agent_router_plans(workspace_jid, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_router_plans_status
      ON agent_router_plans(status, updated_at);

    CREATE TABLE IF NOT EXISTS agent_router_tasks (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      agent_binding_id TEXT,
      agent_profile_id TEXT NOT NULL,
      title TEXT NOT NULL,
      input_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'skipped')),
      attempt INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_expires_at TEXT,
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(plan_id, ordinal),
      FOREIGN KEY (plan_id) REFERENCES agent_router_plans(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_binding_id) REFERENCES workspace_agent_bindings(id) ON DELETE SET NULL,
      FOREIGN KEY (agent_profile_id) REFERENCES agent_profiles(id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_router_tasks_ready
      ON agent_router_tasks(plan_id, status, ordinal);

    CREATE TABLE IF NOT EXISTS agent_router_events (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      task_id TEXT,
      ordinal INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(plan_id, ordinal),
      FOREIGN KEY (plan_id) REFERENCES agent_router_plans(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES agent_router_tasks(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_router_events_plan
      ON agent_router_events(plan_id, ordinal);
  `);
}

function migrateAgentRouterLeases(db: Database.Database): void {
  db.exec(`
    ALTER TABLE agent_router_plans ADD COLUMN dispatch_owner TEXT;
    ALTER TABLE agent_router_plans ADD COLUMN dispatch_lease_expires_at TEXT;
    CREATE INDEX IF NOT EXISTS idx_agent_router_plans_dispatch_lease
      ON agent_router_plans(status, dispatch_lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_agent_router_tasks_dispatch_lease
      ON agent_router_tasks(status, lease_expires_at);
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
  { version: 9, name: 'execution_policy', up: migrateExecutionPolicy },
  { version: 10, name: 'provider_tables', up: createProviderTables },
  { version: 11, name: 'usage_billing_tables', up: createUsageBillingTables },
  { version: 12, name: 'billing_quota_overrides', up: createQuotaOverrideTables },
  { version: 13, name: 'runtime_context', up: migrateRuntimeContext },
  { version: 14, name: 'workspace_members', up: migrateWorkspaceMembers },
  { version: 15, name: 'capability_governance', up: migrateCapabilityGovernance },
  { version: 16, name: 'agent_router', up: migrateAgentRouter },
  { version: 17, name: 'agent_router_leases', up: migrateAgentRouterLeases },
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
