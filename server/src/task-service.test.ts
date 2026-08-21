import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { FakePiRunner } from '@deep-worker/pi-runner';
import { initDatabase } from './db/migration.js';
import { RuntimeRunnerService } from './runtime-runner-service.js';
import { createWorkspace } from './workspaces.js';
import { createTask } from './task-store.js';
import { TaskService } from './task-service.js';

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(':memory:');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, display_name, role, status, permissions, created_at, updated_at)
     VALUES ('u1', 'u1', 'x', '管理员', 'admin', 'active', '[]', ?, ?),
            ('u2', 'u2', 'x', '普通用户', 'member', 'active', '[]', ?, ?)`,
  ).run(now, now, now, now);
  createWorkspace(db, 'u1', { jid: 'w1', name: '工作区', folder: 'w1' });
  createWorkspace(db, 'u2', { jid: 'w2', name: '普通工作区', folder: 'w2' });
});

describe('任务执行服务', () => {
  it('执行失败后按退避重试，并且通知失败不会重新执行任务', async () => {
    const runner = new FakePiRunner({ response: '完成', failuresBeforeSuccess: 1 });
    const runnerService = new RuntimeRunnerService({ db, runner, retryBaseMs: 0 });
    let notifications = 0;
    const service = new TaskService({
      db,
      runnerService,
      maxAttempts: 2,
      notify: async () => {
        notifications += 1;
        if (notifications === 1) throw new Error('通知通道暂时不可用');
      },
    });
    const task = createTask(db, {
      ownerUserId: 'u1', workspaceJid: 'w1', name: '重试任务', executionType: 'agent',
      scheduleType: 'interval', scheduleValue: '60000', prompt: '执行', contextMode: 'group',
    });
    service.start();
    const run = service.runNow('u1', task.id, 'retry-key');
    for (let i = 0; i < 30; i += 1) {
      const current = db.prepare('SELECT status, notification_status FROM task_runs WHERE id = ?').get(run.id) as { status: string; notification_status: string };
      if (current.status === 'completed' && runner.calls.length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(runner.calls).toHaveLength(2);
    expect(db.prepare('SELECT status FROM task_runs WHERE id = ?').get(run.id)).toMatchObject({ status: 'completed' });
    expect(notifications).toBe(1);
    db.prepare('UPDATE task_notifications SET next_attempt_at = ? WHERE run_id = ?').run(new Date().toISOString(), run.id);
    service.tick();
    for (let i = 0; i < 10; i += 1) {
      const status = db.prepare('SELECT notification_status FROM task_runs WHERE id = ?').get(run.id) as { notification_status: string };
      if (status.notification_status === 'delivered') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(notifications).toBe(2);
    expect(db.prepare('SELECT notification_status FROM task_runs WHERE id = ?').get(run.id)).toMatchObject({ notification_status: 'delivered' });
    await service.close();
    await runnerService.close();
  });

  it('拒绝普通用户创建脚本任务', async () => {
    const runnerService = new RuntimeRunnerService({ db, runner: new FakePiRunner() });
    const service = new TaskService({ db, runnerService });
    expect(() => service.createTask({
      ownerUserId: 'u2', workspaceJid: 'w2', name: '危险脚本', executionType: 'script',
      scheduleType: 'interval', scheduleValue: '60000', scriptCommand: 'echo unsafe',
    })).toThrow('管理员');
    await service.close();
    await runnerService.close();
  });
});
