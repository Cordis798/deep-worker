import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

export type TaskScheduleType = 'cron' | 'interval' | 'once';
export type TaskExecutionType = 'agent' | 'script';
export type TaskContextMode = 'group' | 'isolated';
export type TaskStatus = 'active' | 'paused' | 'completed' | 'deleted';
export type TaskRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'missed'
  | 'stopped';
export type TaskNotificationStatus = 'pending' | 'delivered' | 'failed' | 'skipped';

export interface ScheduledTaskRow {
  id: string;
  owner_user_id: string;
  workspace_jid: string;
  name: string;
  execution_type: TaskExecutionType;
  schedule_type: TaskScheduleType;
  schedule_value: string;
  prompt: string;
  script_command: string | null;
  context_mode: TaskContextMode;
  status: TaskStatus;
  next_run_at: string | null;
  last_run_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface TaskRunRow {
  id: string;
  task_id: string;
  idempotency_key: string | null;
  occurrence_key: string;
  trigger_type: 'scheduled' | 'manual' | 'recovery';
  scheduled_for: string;
  definition_snapshot: string;
  status: TaskRunStatus;
  attempt: number;
  retry_available_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  result_text: string | null;
  error: string | null;
  notification_status: TaskNotificationStatus;
  created_at: string;
  updated_at: string;
}

export interface TaskNotificationRow {
  id: string;
  run_id: string;
  status: Exclude<TaskNotificationStatus, 'skipped'>;
  attempts: number;
  next_attempt_at: string;
  payload_json: string;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTaskInput {
  ownerUserId: string;
  workspaceJid: string;
  name: string;
  executionType: TaskExecutionType;
  scheduleType: TaskScheduleType;
  scheduleValue: string;
  prompt?: string;
  scriptCommand?: string | null;
  contextMode?: TaskContextMode;
}

export interface UpdateTaskInput {
  name?: string;
  executionType?: TaskExecutionType;
  scheduleType?: TaskScheduleType;
  scheduleValue?: string;
  prompt?: string;
  scriptCommand?: string | null;
  contextMode?: TaskContextMode;
  status?: Extract<TaskStatus, 'active' | 'paused'>;
}

const MIN_INTERVAL_MS = 60_000;
const CRON_FIELD_LIMITS = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 40)}`;
}

function parseCronField(value: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) throw new Error('Cron 字段不能为空');
    const [base, stepText] = trimmed.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error('Cron 步长无效');
    let start = min;
    let end = max;
    if (base !== '*') {
      const range = base.split('-');
      if (range.length === 1) {
        start = Number(range[0]);
        end = start;
      } else if (range.length === 2) {
        start = Number(range[0]);
        end = Number(range[1]);
      } else {
        throw new Error('Cron 范围无效');
      }
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error('Cron 数值超出范围');
    }
    for (let item = start; item <= end; item += step) result.add(item);
  }
  return result;
}

function parseCron(value: string): [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>] {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Cron 必须包含五个字段');
  return fields.map((field, index) => {
    const limits = CRON_FIELD_LIMITS[index]!;
    return parseCronField(field, limits[0], limits[1]);
  }) as [
    Set<number>, Set<number>, Set<number>, Set<number>, Set<number>
  ];
}

/** 计算严格晚于起点的下一次执行时间，Cron 按 UTC 分钟解释。 */
export function computeNextRunAt(
  type: TaskScheduleType,
  value: string,
  from = new Date(),
): string | null {
  if (type === 'once') {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('一次性任务时间无效');
    return date.toISOString();
  }
  if (type === 'interval') {
    const interval = Number(value);
    if (!Number.isInteger(interval) || interval < MIN_INTERVAL_MS) {
      throw new Error('固定间隔不能小于 60 秒');
    }
    return new Date(from.getTime() + interval).toISOString();
  }
  const [minutes, hours, days, months, weekdays] = parseCron(value);
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  for (let i = 0; i < 1_100_000; i += 1) {
    const weekday = cursor.getUTCDay();
    const weekdayMatches = weekdays.has(weekday) || (weekday === 0 && weekdays.has(7));
    if (
      minutes.has(cursor.getUTCMinutes()) &&
      hours.has(cursor.getUTCHours()) &&
      days.has(cursor.getUTCDate()) &&
      months.has(cursor.getUTCMonth() + 1) &&
      weekdayMatches
    ) {
      return cursor.toISOString();
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  throw new Error('Cron 无法计算下一次执行时间');
}

export function validateSchedule(type: TaskScheduleType, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('调度值不能为空');
  const next = computeNextRunAt(type, trimmed);
  if (type === 'once' && next && new Date(next).getTime() <= Date.now()) {
    throw new Error('一次性任务时间必须在未来');
  }
  return trimmed;
}

function mapTask(row: unknown): ScheduledTaskRow {
  return row as ScheduledTaskRow;
}

function mapRun(row: unknown): TaskRunRow {
  return row as TaskRunRow;
}

function mapNotification(row: unknown): TaskNotificationRow {
  return row as TaskNotificationRow;
}

function taskSnapshot(task: ScheduledTaskRow): string {
  return JSON.stringify({
    id: task.id,
    revision: task.revision,
    workspace_jid: task.workspace_jid,
    name: task.name,
    execution_type: task.execution_type,
    prompt: task.prompt,
    script_command: task.script_command,
    context_mode: task.context_mode,
  });
}

export function getTask(db: Database.Database, id: string): ScheduledTaskRow | undefined {
  return mapTask(db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id));
}

export function getOwnedTask(
  db: Database.Database,
  ownerUserId: string,
  id: string,
): ScheduledTaskRow | undefined {
  return mapTask(
    db.prepare('SELECT * FROM scheduled_tasks WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL').get(id, ownerUserId),
  );
}

export function listOwnedTasks(db: Database.Database, ownerUserId: string): ScheduledTaskRow[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks WHERE owner_user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC')
    .all(ownerUserId)
    .map(mapTask);
}

export function createTask(db: Database.Database, input: CreateTaskInput): ScheduledTaskRow {
  const scheduleValue = validateSchedule(input.scheduleType, input.scheduleValue);
  if (input.executionType === 'agent' && !input.prompt?.trim()) throw new Error('智能体任务必须填写提示词');
  if (input.executionType === 'script' && !input.scriptCommand?.trim()) throw new Error('脚本任务必须填写命令');
  const now = nowIso();
  const id = newId('task');
  const nextRunAt = computeNextRunAt(input.scheduleType, scheduleValue, new Date(now));
  db.prepare(
    `INSERT INTO scheduled_tasks (
      id, owner_user_id, workspace_jid, name, execution_type, schedule_type,
      schedule_value, prompt, script_command, context_mode, status, next_run_at,
      revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 1, ?, ?)`,
  ).run(
    id,
    input.ownerUserId,
    input.workspaceJid,
    input.name.trim(),
    input.executionType,
    input.scheduleType,
    scheduleValue,
    input.prompt?.trim() ?? '',
    input.scriptCommand?.trim() ?? null,
    input.contextMode ?? 'isolated',
    nextRunAt,
    now,
    now,
  );
  return getTask(db, id)!;
}

export function updateTask(
  db: Database.Database,
  ownerUserId: string,
  id: string,
  expectedRevision: number,
  input: UpdateTaskInput,
): { ok: true; task: ScheduledTaskRow } | { ok: false; reason: 'not_found' | 'conflict' } {
  const current = getOwnedTask(db, ownerUserId, id);
  if (!current) return { ok: false, reason: 'not_found' };
  if (current.revision !== expectedRevision) return { ok: false, reason: 'conflict' };
  const nextType = input.scheduleType ?? current.schedule_type;
  const nextValue = input.scheduleValue ?? current.schedule_value;
  const scheduleValue = validateSchedule(nextType, nextValue);
  const executionType = input.executionType ?? current.execution_type;
  const prompt = input.prompt ?? current.prompt;
  const script = input.scriptCommand === undefined ? current.script_command : input.scriptCommand;
  if (executionType === 'agent' && !prompt.trim()) throw new Error('智能体任务必须填写提示词');
  if (executionType === 'script' && !script?.trim()) throw new Error('脚本任务必须填写命令');
  const now = nowIso();
  const status = input.status ?? current.status;
  const statusChanged = input.status !== undefined && input.status !== current.status;
  const nextRunAt = input.scheduleType || input.scheduleValue || statusChanged
    ? input.status === 'paused'
      ? null
      : computeNextRunAt(nextType, scheduleValue, new Date(now))
    : current.next_run_at;
  const result = db.prepare(
    `UPDATE scheduled_tasks SET name = ?, execution_type = ?, schedule_type = ?,
      schedule_value = ?, prompt = ?, script_command = ?, context_mode = ?,
      status = ?, next_run_at = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND revision = ? AND deleted_at IS NULL`,
  ).run(
    input.name?.trim() ?? current.name,
    executionType,
    nextType,
    scheduleValue,
    prompt.trim(),
    script?.trim() ?? null,
    input.contextMode ?? current.context_mode,
    status,
    nextRunAt,
    now,
    id,
    ownerUserId,
    expectedRevision,
  );
  if (result.changes !== 1) return { ok: false, reason: 'conflict' };
  return { ok: true, task: getTask(db, id)! };
}

export function softDeleteTask(db: Database.Database, ownerUserId: string, id: string): boolean {
  const now = nowIso();
  const result = db.prepare(
    `UPDATE scheduled_tasks SET status = 'deleted', deleted_at = ?, next_run_at = NULL,
      revision = revision + 1, updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL`,
  ).run(now, now, id, ownerUserId);
  return result.changes === 1;
}

export function stopTaskRun(db: Database.Database, ownerUserId: string, runId: string): boolean {
  const now = nowIso();
  const result = db.prepare(
    `UPDATE task_runs SET status = 'stopped', error = '用户主动停止', completed_at = ?,
      updated_at = ? WHERE id = ? AND status IN ('queued', 'running')
      AND task_id IN (SELECT id FROM scheduled_tasks WHERE owner_user_id = ?)`,
  ).run(now, now, runId, ownerUserId);
  return result.changes === 1;
}

function hasActiveRun(db: Database.Database, taskId: string): boolean {
  const row = db.prepare("SELECT 1 FROM task_runs WHERE task_id = ? AND status IN ('queued', 'running') LIMIT 1").get(taskId);
  return !!row;
}

function insertRun(
  db: Database.Database,
  task: ScheduledTaskRow,
  input: {
    id: string;
    occurrenceKey: string;
    triggerType: TaskRunRow['trigger_type'];
    idempotencyKey: string | null;
    scheduledFor: string;
    status: TaskRunStatus;
    error?: string | null;
  },
): TaskRunRow {
  const now = nowIso();
  db.prepare(
    `INSERT INTO task_runs (
      id, task_id, idempotency_key, occurrence_key, trigger_type, scheduled_for,
      definition_snapshot, status, attempt, created_at, updated_at, error,
      completed_at, notification_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    task.id,
    input.idempotencyKey,
    input.occurrenceKey,
    input.triggerType,
    input.scheduledFor,
    taskSnapshot(task),
    input.status,
    now,
    now,
    input.error ?? null,
    input.status === 'missed' ? now : null,
    input.status === 'missed' ? 'skipped' : 'pending',
  );
  return getRun(db, input.id)!;
}

export function getRun(db: Database.Database, id: string): TaskRunRow | undefined {
  return mapRun(db.prepare('SELECT * FROM task_runs WHERE id = ?').get(id));
}

export function listTaskRuns(db: Database.Database, ownerUserId: string, taskId?: string): TaskRunRow[] {
  const rows = taskId
    ? db.prepare(
        `SELECT tr.* FROM task_runs tr JOIN scheduled_tasks st ON st.id = tr.task_id
         WHERE st.owner_user_id = ? AND tr.task_id = ? ORDER BY tr.created_at DESC LIMIT 100`,
      ).all(ownerUserId, taskId)
    : db.prepare(
        `SELECT tr.* FROM task_runs tr JOIN scheduled_tasks st ON st.id = tr.task_id
         WHERE st.owner_user_id = ? ORDER BY tr.created_at DESC LIMIT 100`,
      ).all(ownerUserId);
  return rows.map(mapRun);
}

export function createManualRun(
  db: Database.Database,
  ownerUserId: string,
  taskId: string,
  idempotencyKey: string,
): { created: boolean; run: TaskRunRow } {
  const task = getOwnedTask(db, ownerUserId, taskId);
  if (!task) throw new Error('任务不存在');
  const key = idempotencyKey.trim();
  if (!key) throw new Error('幂等键不能为空');
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM task_runs WHERE task_id = ? AND idempotency_key = ?').get(taskId, key);
    if (existing) return { created: false, run: mapRun(existing) };
    const runId = stableId('run', `${taskId}:manual:${key}`);
    const run = insertRun(db, task, {
      id: runId,
      occurrenceKey: `${taskId}:manual:${key}`,
      triggerType: 'manual',
      idempotencyKey: key,
      scheduledFor: nowIso(),
      status: 'queued',
    });
    return { created: true, run };
  })();
}

/** 取出到期任务并推进调度游标；startup 时周期任务不补跑，只记录 missed。 */
export function materializeDueTasks(
  db: Database.Database,
  now = new Date(),
  startupAt?: Date,
): TaskRunRow[] {
  const nowText = now.toISOString();
  const due = db.prepare(
    `SELECT * FROM scheduled_tasks WHERE status = 'active' AND deleted_at IS NULL
     AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT 100`,
  ).all(nowText).map(mapTask);
  const created: TaskRunRow[] = [];
  for (const task of due) {
    const scheduledFor = task.next_run_at!;
    db.transaction(() => {
      const current = getTask(db, task.id);
      if (!current || current.status !== 'active' || current.next_run_at !== scheduledFor) return;
      const periodic = current.schedule_type !== 'once';
      const missedOnRestart = !!startupAt && periodic && new Date(scheduledFor).getTime() < startupAt.getTime();
      const busy = hasActiveRun(db, current.id);
      let next: string | null = null;
      let scheduleError: string | null = null;
      try {
        next = periodic ? computeNextRunAt(current.schedule_type, current.schedule_value, new Date(scheduledFor)) : null;
      } catch (error) {
        scheduleError = `调度配置无效：${error instanceof Error ? error.message : String(error)}`;
      }
      const missed = missedOnRestart || busy || !!scheduleError;
      const run = insertRun(db, current, {
        id: newId('run'),
        occurrenceKey: `${current.id}:${scheduledFor}`,
        triggerType: missedOnRestart ? 'recovery' : 'scheduled',
        idempotencyKey: null,
        scheduledFor,
        status: missed ? 'missed' : 'queued',
        error: scheduleError ?? (missedOnRestart ? '服务离线期间错过执行' : busy ? '上一轮执行尚未结束' : null),
      });
      const updated = db.prepare(
        `UPDATE scheduled_tasks SET next_run_at = ?, last_run_at = ?, status = ?,
         updated_at = ? WHERE id = ? AND next_run_at = ?`,
      ).run(next, scheduledFor, scheduleError ? 'paused' : next ? 'active' : 'completed', nowText, current.id, scheduledFor);
      if (updated.changes === 1) created.push(run);
    })();
  }
  return created;
}

export function recoverExpiredRuns(db: Database.Database, now = new Date(), maxAttempts = 3): number {
  const result = db.prepare(
    `UPDATE task_runs SET status = CASE WHEN attempt >= ? THEN 'failed' ELSE 'queued' END,
      error = CASE WHEN attempt >= ? THEN '执行租约过期，已达到重试上限' ELSE '执行租约过期，等待恢复' END,
      retry_available_at = CASE WHEN attempt >= ? THEN NULL ELSE ? END,
      lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
  ).run(maxAttempts, maxAttempts, maxAttempts, now.toISOString(), now.toISOString(), now.toISOString());
  return result.changes;
}

export function claimNextRun(db: Database.Database, workerId: string, leaseMs: number): TaskRunRow | undefined {
  return db.transaction(() => {
    const row = db.prepare(
      `SELECT tr.* FROM task_runs tr JOIN scheduled_tasks st ON st.id = tr.task_id
       WHERE tr.status = 'queued' AND st.status <> 'deleted'
       AND (tr.retry_available_at IS NULL OR tr.retry_available_at <= ?)
       AND NOT EXISTS (SELECT 1 FROM task_runs active WHERE active.task_id = tr.task_id AND active.status = 'running')
       ORDER BY tr.created_at ASC LIMIT 1`,
    ).get(nowIso()) as TaskRunRow | undefined;
    if (!row) return undefined;
    const now = new Date();
    const expires = new Date(now.getTime() + leaseMs).toISOString();
    const changed = db.prepare(
      `UPDATE task_runs SET status = 'running', attempt = attempt + 1,
       lease_owner = ?, lease_expires_at = ?, started_at = COALESCE(started_at, ?),
       updated_at = ? WHERE id = ? AND status = 'queued'`,
    ).run(workerId, expires, now.toISOString(), now.toISOString(), row.id);
    return changed.changes === 1 ? getRun(db, row.id) : undefined;
  })();
}

export function completeRun(
  db: Database.Database,
  runId: string,
  workerId: string,
  status: Extract<TaskRunStatus, 'completed' | 'failed' | 'stopped'>,
  resultText: string | null,
  error: string | null,
): TaskRunRow | undefined {
  const now = new Date();
  const current = getRun(db, runId);
  if (!current || current.status !== 'running' || current.lease_owner !== workerId) return undefined;
  const duration = current.started_at ? Math.max(0, now.getTime() - new Date(current.started_at).getTime()) : null;
  db.prepare(
    `UPDATE task_runs SET status = ?, result_text = ?, error = ?, completed_at = ?,
     duration_ms = ?, retry_available_at = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND status = 'running' AND lease_owner = ?`,
  ).run(status, resultText, error, now.toISOString(), duration, now.toISOString(), runId, workerId);
  return getRun(db, runId);
}

export function retryRun(db: Database.Database, runId: string, workerId: string, error: string, maxAttempts: number): boolean {
  const current = getRun(db, runId);
  if (!current) return false;
  const retryAt = new Date(Date.now() + Math.min(30_000, 250 * 2 ** Math.max(0, current.attempt - 1))).toISOString();
  const result = db.prepare(
    `UPDATE task_runs SET status = CASE WHEN attempt >= ? THEN 'failed' ELSE 'queued' END,
      error = ?, retry_available_at = CASE WHEN attempt >= ? THEN NULL ELSE ? END,
      lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ?`,
  ).run(maxAttempts, error, maxAttempts, retryAt, nowIso(), runId, workerId);
  return result.changes === 1;
}

export function createTaskNotification(db: Database.Database, run: TaskRunRow, payload: unknown): void {
  const now = nowIso();
  db.prepare(
    `INSERT OR IGNORE INTO task_notifications
      (id, run_id, status, attempts, next_attempt_at, payload_json, created_at, updated_at)
      VALUES (?, ?, 'pending', 0, ?, ?, ?, ?)`,
  ).run(newId('notice'), run.id, now, JSON.stringify(payload), now, now);
}

export function listDueNotifications(db: Database.Database, now = new Date()): TaskNotificationRow[] {
  return db.prepare(
    `SELECT * FROM task_notifications WHERE status = 'pending' AND next_attempt_at <= ?
     ORDER BY created_at ASC LIMIT 50`,
  ).all(now.toISOString()).map(mapNotification);
}

export function markNotification(
  db: Database.Database,
  notificationId: string,
  delivered: boolean,
  error?: string,
): void {
  const now = new Date();
  if (delivered) {
    db.transaction(() => {
      db.prepare("UPDATE task_notifications SET status = 'delivered', delivered_at = ?, updated_at = ? WHERE id = ?").run(now.toISOString(), now.toISOString(), notificationId);
      db.prepare("UPDATE task_runs SET notification_status = 'delivered', updated_at = ? WHERE id = (SELECT run_id FROM task_notifications WHERE id = ?)").run(now.toISOString(), notificationId);
    })();
    return;
  }
  const row = db.prepare('SELECT attempts FROM task_notifications WHERE id = ?').get(notificationId) as { attempts: number } | undefined;
  const attempts = (row?.attempts ?? 0) + 1;
  const retryAt = new Date(now.getTime() + Math.min(60_000, 1_000 * 2 ** Math.min(attempts - 1, 6))).toISOString();
  db.transaction(() => {
    db.prepare("UPDATE task_notifications SET status = 'pending', attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?").run(attempts, retryAt, error ?? '通知失败', now.toISOString(), notificationId);
    db.prepare("UPDATE task_runs SET notification_status = 'failed', updated_at = ? WHERE id = (SELECT run_id FROM task_notifications WHERE id = ?)").run(now.toISOString(), notificationId);
  })();
}

export { MIN_INTERVAL_MS };
