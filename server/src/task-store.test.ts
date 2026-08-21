import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from './db/migration.js';
import { createWorkspace } from './workspaces.js';
import {
  computeNextRunAt,
  createManualRun,
  createTask,
  getRun,
  materializeDueTasks,
  recoverExpiredRuns,
} from './task-store.js';

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(':memory:');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, display_name, role, status, permissions, created_at, updated_at)
     VALUES ('u1', 'u1', 'x', '用户', 'admin', 'active', '[]', ?, ?)`,
  ).run(now, now);
  createWorkspace(db, 'u1', { jid: 'w1', name: '工作区', folder: 'w1' });
});

describe('任务状态存储', () => {
  it('限制固定间隔并计算五字段 Cron', () => {
    expect(() => computeNextRunAt('interval', '59999')).toThrow('60 秒');
    expect(computeNextRunAt('cron', '*/5 * * * *', new Date('2026-08-21T10:01:00.000Z'))).toBe('2026-08-21T10:05:00.000Z');
  });

  it('手动运行使用任务级稳定幂等键', () => {
    const task = createTask(db, {
      ownerUserId: 'u1', workspaceJid: 'w1', name: '手动任务', executionType: 'agent',
      scheduleType: 'interval', scheduleValue: '60000', prompt: '回复',
    });
    const first = createManualRun(db, 'u1', task.id, 'same-key');
    const second = createManualRun(db, 'u1', task.id, 'same-key');
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
  });

  it('重启时周期任务记为 missed，一次性任务保留补跑记录', () => {
    const old = new Date('2026-08-21T09:00:00.000Z');
    const periodic = createTask(db, {
      ownerUserId: 'u1', workspaceJid: 'w1', name: '周期任务', executionType: 'agent',
      scheduleType: 'interval', scheduleValue: '60000', prompt: '周期',
    });
    const once = createTask(db, {
      ownerUserId: 'u1', workspaceJid: 'w1', name: '一次任务', executionType: 'agent',
      scheduleType: 'once', scheduleValue: '2026-08-21T09:00:00.000Z', prompt: '一次',
    });
    db.prepare('UPDATE scheduled_tasks SET next_run_at = ? WHERE id IN (?, ?)').run(old.toISOString(), periodic.id, once.id);
    const runs = materializeDueTasks(db, new Date('2026-08-21T10:00:00.000Z'), new Date('2026-08-21T09:30:00.000Z'));
    expect(runs.map((run) => run.status)).toEqual(['missed', 'queued']);
    expect(getRun(db, runs[0]!.id)?.trigger_type).toBe('recovery');
  });

  it('租约过期后重新排队，达到上限后失败', () => {
    const task = createTask(db, {
      ownerUserId: 'u1', workspaceJid: 'w1', name: '恢复任务', executionType: 'agent',
      scheduleType: 'interval', scheduleValue: '60000', prompt: '恢复',
    });
    const run = createManualRun(db, 'u1', task.id, 'lease').run;
    db.prepare("UPDATE task_runs SET status = 'running', attempt = 1, lease_owner = 'dead', lease_expires_at = ? WHERE id = ?").run('2020-01-01T00:00:00.000Z', run.id);
    expect(recoverExpiredRuns(db, new Date('2020-01-01T00:01:00.000Z'), 3)).toBe(1);
    expect(getRun(db, run.id)?.status).toBe('queued');
    db.prepare("UPDATE task_runs SET status = 'running', attempt = 3, lease_owner = 'dead', lease_expires_at = ? WHERE id = ?").run('2020-01-01T00:00:00.000Z', run.id);
    recoverExpiredRuns(db, new Date('2020-01-01T00:01:00.000Z'), 3);
    expect(getRun(db, run.id)?.status).toBe('failed');
  });
});
