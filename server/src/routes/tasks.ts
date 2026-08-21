import crypto from 'node:crypto';
import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { getOwnedWorkspace } from '../workspaces.js';
import { effectiveExecutionMode } from '../execution-policy.js';
import { TaskService } from '../task-service.js';
import type { AppVariables } from '../types.js';
import type { TaskExecutionType, TaskScheduleType, TaskContextMode } from '../task-store.js';

function taskPublic(task: ReturnType<TaskService['getTask']>) {
  if (!task) return null;
  return {
    id: task.id,
    owner_user_id: task.owner_user_id,
    workspace_jid: task.workspace_jid,
    name: task.name,
    execution_type: task.execution_type,
    schedule_type: task.schedule_type,
    schedule_value: task.schedule_value,
    prompt: task.prompt,
    script_command: task.script_command,
    context_mode: task.context_mode,
    status: task.status,
    next_run_at: task.next_run_at,
    last_run_at: task.last_run_at,
    revision: task.revision,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

function runPublic(run: ReturnType<TaskService['listRuns']>[number]) {
  return {
    ...run,
    definition_snapshot: JSON.parse(run.definition_snapshot),
  };
}

function invalidBody(body: Record<string, unknown>): string | undefined {
  if (typeof body.name !== 'string' || !body.name.trim()) return '任务名称不能为空';
  if (!['agent', 'script'].includes(String(body.execution_type))) return '执行类型无效';
  if (!['cron', 'interval', 'once'].includes(String(body.schedule_type))) return '调度类型无效';
  if (body.context_mode !== undefined && !['group', 'isolated'].includes(String(body.context_mode))) return '上下文模式无效';
  return undefined;
}

export function createTaskRoutes(service: TaskService, db: Parameters<typeof getOwnedWorkspace>[0]) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use('*', authMiddleware(db));

  app.get('/', (c) => {
    const user = c.get('user')!;
    return c.json({ tasks: service.listTasks(user.id).map((task) => taskPublic(task)) });
  });

  app.post('/', async (c) => {
    const user = c.get('user')!;
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const error = invalidBody(body);
    if (error) return c.json({ error }, 400);
    const workspaceJid = typeof body.workspace_jid === 'string' ? body.workspace_jid : '';
    const workspace = getOwnedWorkspace(db, user.id, workspaceJid);
    if (!workspace) return c.json({ error: '工作区不存在' }, 404);
    const executionType = body.execution_type as TaskExecutionType;
    if (executionType === 'script' && (user.role !== 'admin' || effectiveExecutionMode(db, workspace) !== 'host')) {
      return c.json({ error: '脚本任务只允许管理员在 Host 工作区执行' }, 403);
    }
    try {
      const task = service.createTask({
        ownerUserId: user.id,
        workspaceJid,
        name: String(body.name),
        executionType,
        scheduleType: body.schedule_type as TaskScheduleType,
        scheduleValue: String(body.schedule_value ?? ''),
        prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
        scriptCommand: typeof body.script_command === 'string' ? body.script_command : null,
        contextMode: (body.context_mode as TaskContextMode | undefined) ?? 'isolated',
      });
      return c.json({ task: taskPublic(task) }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : '创建任务失败' }, 400);
    }
  });

  app.get('/:taskId', (c) => {
    const task = service.getTask(c.get('user')!.id, c.req.param('taskId'));
    return task ? c.json({ task: taskPublic(task) }) : c.json({ error: '任务不存在' }, 404);
  });

  app.patch('/:taskId', async (c) => {
    const user = c.get('user')!;
    const task = service.getTask(user.id, c.req.param('taskId'));
    if (!task) return c.json({ error: '任务不存在' }, 404);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const expectedRevision = Number(body.expected_revision);
    if (!Number.isInteger(expectedRevision)) return c.json({ error: 'expected_revision 必须是整数' }, 400);
    const executionType = (body.execution_type as TaskExecutionType | undefined) ?? task.execution_type;
    const workspace = getOwnedWorkspace(db, user.id, task.workspace_jid);
    if (executionType === 'script' && (user.role !== 'admin' || !workspace || effectiveExecutionMode(db, workspace) !== 'host')) {
      return c.json({ error: '脚本任务只允许管理员在 Host 工作区执行' }, 403);
    }
    try {
      const result = service.updateTask(user.id, task.id, expectedRevision, {
        name: typeof body.name === 'string' ? body.name : undefined,
        executionType,
        scheduleType: body.schedule_type as TaskScheduleType | undefined,
        scheduleValue: typeof body.schedule_value === 'string' ? body.schedule_value : undefined,
        prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
        scriptCommand: typeof body.script_command === 'string' ? body.script_command : undefined,
        contextMode: body.context_mode as TaskContextMode | undefined,
        status: body.status as 'active' | 'paused' | undefined,
      });
      if (!result.ok) return c.json({ error: result.reason === 'conflict' ? '任务版本已变化，请刷新后重试' : '任务不存在' }, result.reason === 'conflict' ? 409 : 404);
      return c.json({ task: taskPublic(result.task) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : '更新任务失败' }, 400);
    }
  });

  app.delete('/:taskId', (c) => {
    const ok = service.deleteTask(c.get('user')!.id, c.req.param('taskId'));
    return ok ? c.json({ success: true }) : c.json({ error: '任务不存在' }, 404);
  });

  app.get('/:taskId/runs', (c) => {
    const task = service.getTask(c.get('user')!.id, c.req.param('taskId'));
    if (!task) return c.json({ error: '任务不存在' }, 404);
    return c.json({ runs: service.listRuns(c.get('user')!.id, task.id).map(runPublic) });
  });

  app.post('/:taskId/run', async (c) => {
    const user = c.get('user')!;
    const task = service.getTask(user.id, c.req.param('taskId'));
    if (!task) return c.json({ error: '任务不存在' }, 404);
    const body = await c.req.json().catch(() => ({})) as { idempotency_key?: unknown };
    const key = c.req.header('idempotency-key') ?? (typeof body.idempotency_key === 'string' ? body.idempotency_key : crypto.randomUUID());
    try {
      const run = service.runNow(user.id, task.id, key);
      return c.json({ run: runPublic(run) }, 202);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : '任务启动失败' }, 400);
    }
  });

  app.post('/:taskId/stop', (c) => {
    const task = service.getTask(c.get('user')!.id, c.req.param('taskId'));
    if (!task) return c.json({ error: '任务不存在' }, 404);
    return c.json({ stopped: service.stopTask(c.get('user')!.id, task.id) });
  });

  app.post('/:taskId/runs/:runId/stop', (c) => {
    const task = service.getTask(c.get('user')!.id, c.req.param('taskId'));
    if (!task) return c.json({ error: '任务不存在' }, 404);
    const ok = service.stopRun(c.get('user')!.id, c.req.param('runId'));
    return ok ? c.json({ success: true }) : c.json({ error: '运行记录不存在或已结束' }, 409);
  });

  return app;
}
