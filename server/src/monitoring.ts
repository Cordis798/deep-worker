import type Database from 'better-sqlite3';
import type { RuntimeRunnerService } from './runtime-runner-service.js';
import type { TaskService } from './task-service.js';

export interface ContainerRunnerStatusSource { size?: () => number; }

export function getMonitorSnapshot(
  db: Database.Database,
  runtimeRunner: RuntimeRunnerService,
  taskService: TaskService,
  containerRunner: ContainerRunnerStatusSource,
) {
  const runnerCounts = db.prepare(
    `SELECT
       SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
       SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
       SUM(CASE WHEN status = 'retry_wait' THEN 1 ELSE 0 END) AS retry_wait
     FROM runner_turns WHERE status IN ('queued', 'running', 'retry_wait')`,
  ).get() as { queued: number | null; running: number | null; retry_wait: number | null };
  const hostRunning = db.prepare(
    `SELECT COUNT(*) AS count FROM runner_turns tr
     JOIN workspaces w ON w.jid = tr.workspace_jid
     WHERE tr.status = 'running' AND w.execution_mode = 'host'`,
  ).get() as { count: number };
  const providerRows = db.prepare(
    `SELECT id, owner_user_id, provider, model_id, enabled, weight FROM provider_configs ORDER BY owner_user_id, created_at`,
  ).all() as Array<{ id: string; owner_user_id: string; provider: string; model_id: string; enabled: number; weight: number }>;
  const health = new Map(runtimeRunner.getProviderHealthStatuses().map((item) => [`${item.ownerUserId}:${item.provider.id}`, item.provider]));
  return {
    queue: { runner: runtimeRunner.getQueueStatus(), persisted: { queued: runnerCounts.queued ?? 0, running: runnerCounts.running ?? 0, retry_wait: runnerCounts.retry_wait ?? 0 }, tasks: taskService.getStatus() },
    runners: { host: { running: hostRunning.count }, container: { active: typeof containerRunner.size === 'function' ? containerRunner.size() : 0, image: process.env.DEEP_WORKER_CONTAINER_IMAGE ?? 'deep-worker-pi:latest' } },
    providers: providerRows.map((row) => ({
      id: row.id,
      owner_user_id: row.owner_user_id,
      provider: row.provider,
      model_id: row.model_id,
      enabled: row.enabled === 1,
      weight: row.weight,
      health: health.get(`${row.owner_user_id}:${row.id}`) ?? { healthy: true, consecutiveErrors: 0, activeSessionCount: 0 },
    })),
  };
}
