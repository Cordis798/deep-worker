import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import type Database from 'better-sqlite3';
import type { RuntimeRunnerService } from './runtime-runner-service.js';
import { getOwnedWorkspace } from './workspaces.js';
import { getUserById } from './users.js';
import { effectiveExecutionMode } from './execution-policy.js';
import {
  claimNextRun,
  completeRun,
  createManualRun,
  createTask,
  createTaskNotification,
  getOwnedTask,
  getRun,
  listDueNotifications,
  listOwnedTasks,
  listTaskRuns,
  markNotification,
  materializeDueTasks,
  recoverExpiredRuns,
  retryRun,
  softDeleteTask,
  stopTaskRun,
  updateTask,
  type CreateTaskInput,
  type ScheduledTaskRow,
  type TaskRunRow,
  type UpdateTaskInput,
} from './task-store.js';

const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const SCRIPT_MAX_OUTPUT = 512 * 1024;

export interface TaskServiceOptions {
  db: Database.Database;
  runnerService: RuntimeRunnerService;
  notify?: (payload: { run: TaskRunRow; task: ScheduledTaskRow }) => Promise<void>;
  workerId?: string;
  leaseMs?: number;
  maxAttempts?: number;
}

export class TaskService {
  private readonly db: Database.Database;
  private readonly runnerService: RuntimeRunnerService;
  private readonly notify: NonNullable<TaskServiceOptions['notify']>;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly activeProcesses = new Map<string, ChildProcess>();
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(options: TaskServiceOptions) {
    this.db = options.db;
    this.runnerService = options.runnerService;
    this.notify = options.notify ?? (async () => undefined);
    this.workerId = options.workerId ?? `task-worker-${crypto.randomUUID()}`;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  start(): void {
    if (this.timer) return;
    recoverExpiredRuns(this.db, new Date(), this.maxAttempts);
    materializeDueTasks(this.db, new Date(), new Date());
    this.pump();
    this.timer = setInterval(() => this.pump(), 1_000);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const process of this.activeProcesses.values()) process.kill();
    this.activeProcesses.clear();
  }

  listTasks(ownerUserId: string) {
    return listOwnedTasks(this.db, ownerUserId);
  }

  getTask(ownerUserId: string, taskId: string) {
    return getOwnedTask(this.db, ownerUserId, taskId);
  }

  createTask(input: CreateTaskInput) {
    if (input.executionType === 'script') {
      const owner = getUserById(this.db, input.ownerUserId);
      const workspace = getOwnedWorkspace(this.db, input.ownerUserId, input.workspaceJid);
      if (owner?.role !== 'admin' || !workspace || effectiveExecutionMode(this.db, workspace) !== 'host') {
        throw new Error('脚本任务只允许管理员在 Host 工作区执行');
      }
    }
    return createTask(this.db, input);
  }

  updateTask(ownerUserId: string, taskId: string, expectedRevision: number, input: UpdateTaskInput) {
    return updateTask(this.db, ownerUserId, taskId, expectedRevision, input);
  }

  deleteTask(ownerUserId: string, taskId: string): boolean {
    return softDeleteTask(this.db, ownerUserId, taskId);
  }

  listRuns(ownerUserId: string, taskId?: string) {
    return listTaskRuns(this.db, ownerUserId, taskId);
  }

  runNow(ownerUserId: string, taskId: string, idempotencyKey: string): TaskRunRow {
    const result = createManualRun(this.db, ownerUserId, taskId, idempotencyKey);
    this.pump();
    return result.run;
  }

  stopRun(ownerUserId: string, runId: string): boolean {
    const stopped = stopTaskRun(this.db, ownerUserId, runId);
    if (stopped) this.activeProcesses.get(runId)?.kill();
    return stopped;
  }

  stopTask(ownerUserId: string, taskId: string): number {
    let stopped = 0;
    for (const run of listTaskRuns(this.db, ownerUserId, taskId)) {
      if (run.status === 'queued' || run.status === 'running') {
        if (this.stopRun(ownerUserId, run.id)) stopped += 1;
      }
    }
    return stopped;
  }

  tick(now = new Date()): void {
    if (this.closed) return;
    recoverExpiredRuns(this.db, now, this.maxAttempts);
    materializeDueTasks(this.db, now);
    this.pump();
  }

  private pump(): void {
    if (this.closed) return;
    this.deliverNotifications();
    for (let count = 0; count < 20; count += 1) {
      const run = claimNextRun(this.db, this.workerId, this.leaseMs);
      if (!run) break;
      void this.execute(run);
    }
  }

  private async execute(run: TaskRunRow): Promise<void> {
    const task = getOwnedTaskByRun(this.db, run);
    if (!task) {
      completeRun(this.db, run.id, this.workerId, 'failed', null, '任务定义不存在');
      return;
    }
    try {
      const output = task.execution_type === 'script'
        ? await this.executeScript(run, task)
        : await this.executeAgent(run, task);
      const completed = completeRun(this.db, run.id, this.workerId, 'completed', output, null);
      if (completed) createTaskNotification(this.db, completed, { result: output });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      retryRun(this.db, run.id, this.workerId, message, this.maxAttempts);
      const current = getRun(this.db, run.id);
      if (current?.status === 'failed') createTaskNotification(this.db, current, { error: message });
    } finally {
      this.activeProcesses.delete(run.id);
      this.pump();
    }
  }

  private async executeAgent(run: TaskRunRow, task: ScheduledTaskRow): Promise<string> {
    const workspace = getOwnedWorkspace(this.db, task.owner_user_id, task.workspace_jid);
    if (!workspace || workspace.status !== 'active') throw new Error('工作区不存在或已停用');
    const sessionId = task.context_mode === 'group'
      ? `task-session-${task.id}`
      : `task-session-${run.id}`;
    ensureTaskRuntimeSession(this.db, sessionId, task);
    const result = await this.runnerService.submit({
      ownerUserId: task.owner_user_id,
      workspaceJid: task.workspace_jid,
      sessionId,
      message: task.prompt,
      idempotencyKey: `task-run:${run.id}`,
      timeoutMs: DEFAULT_LEASE_MS - 5_000,
    });
    return result.reply ?? '';
  }

  private executeScript(run: TaskRunRow, task: ScheduledTaskRow): Promise<string> {
    const owner = getUserById(this.db, task.owner_user_id);
    const workspace = getOwnedWorkspace(this.db, task.owner_user_id, task.workspace_jid);
    if (owner?.role !== 'admin' || !workspace || workspace.status !== 'active') {
      throw new Error('脚本任务只允许管理员在 Host 工作区执行');
    }
    if (effectiveExecutionMode(this.db, workspace) !== 'host') throw new Error('当前工作区不是 Host 执行模式');
    const command = task.script_command?.trim();
    if (!command) throw new Error('脚本命令为空');
    fs.mkdirSync(workspace.folder, { recursive: true });
    return new Promise((resolve, reject) => {
      const child = spawn(command, {
        cwd: workspace.folder,
        shell: true,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.activeProcesses.set(run.id, child);
      let output = '';
      const append = (chunk: Buffer) => {
        output = `${output}${chunk.toString('utf8')}`.slice(-SCRIPT_MAX_OUTPUT);
      };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('脚本执行超时'));
      }, DEFAULT_LEASE_MS - 5_000);
      timeout.unref?.();
      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        if (code === 0) resolve(output);
        else reject(new Error(`脚本退出码 ${code ?? '未知'}${signal ? `，信号 ${signal}` : ''}: ${output}`));
      });
    });
  }

  private deliverNotifications(): void {
    for (const notification of listDueNotifications(this.db)) {
      const run = getRun(this.db, notification.run_id);
      const task = run ? getOwnedTaskByRun(this.db, run) : undefined;
      if (!run || !task) {
        markNotification(this.db, notification.id, true);
        continue;
      }
      void this.notify({ run, task })
        .then(() => markNotification(this.db, notification.id, true))
        .catch((error: unknown) => markNotification(this.db, notification.id, false, error instanceof Error ? error.message : String(error)));
    }
  }
}

function getOwnedTaskByRun(db: Database.Database, run: TaskRunRow): ScheduledTaskRow | undefined {
  return db.prepare(
    `SELECT st.* FROM scheduled_tasks st JOIN task_runs tr ON tr.task_id = st.id
     WHERE tr.id = ? AND st.id = ?`,
  ).get(run.id, run.task_id) as ScheduledTaskRow | undefined;
}

function ensureTaskRuntimeSession(db: Database.Database, sessionId: string, task: ScheduledTaskRow): void {
  const exists = db.prepare('SELECT 1 FROM runtime_sessions WHERE id = ?').get(sessionId);
  if (exists) return;
  const workspace = getOwnedWorkspace(db, task.owner_user_id, task.workspace_jid);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO runtime_sessions (id, workspace_jid, name, agent_profile_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  ).run(sessionId, task.workspace_jid, `任务：${task.name}`, workspace?.agent_profile_id ?? null, now, now);
}
