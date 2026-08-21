import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { authMiddleware, systemConfigMiddleware } from '../middleware/auth.js';
import { getMonitorSnapshot } from '../monitoring.js';
import { recoverRunnerRuns } from '../runner-reliability.js';
import { recoverExpiredRuns } from '../task-store.js';
import type { RuntimeRunnerService } from '../runtime-runner-service.js';
import type { TaskService } from '../task-service.js';
import type { ContainerRunnerStatusSource } from '../monitoring.js';
import type { AppVariables } from '../types.js';
import { readMountAllowlist, writeMountAllowlist, type MountAllowlist } from '../mount-security.js';
import { runnerLifecycle } from '../runner-lifecycle.js';

export function createMonitorRoutes(
  db: Database.Database,
  runtimeRunner: RuntimeRunnerService,
  taskService: TaskService,
  containerRunner: ContainerRunnerStatusSource,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use('*', authMiddleware(db));
  app.use('*', systemConfigMiddleware(db));
  app.get('/status', (c) => c.json(getMonitorSnapshot(db, runtimeRunner, taskService, containerRunner)));
  app.get('/mount-allowlist', (c) => c.json(readMountAllowlist(db)));
  app.put('/mount-allowlist', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Partial<MountAllowlist>;
    const allowedRoots = Array.isArray(body.allowedRoots) ? body.allowedRoots : [];
    const blockedPatterns = Array.isArray(body.blockedPatterns) ? body.blockedPatterns : [];
    if (!allowedRoots.every((root) => !!root && typeof root === 'object' && typeof root.path === 'string' && typeof root.allowReadWrite === 'boolean') ||
      !blockedPatterns.every((pattern) => typeof pattern === 'string')) {
      return c.json({ error: '挂载 allowlist 格式无效' }, 400);
    }
    runnerLifecycle.pause('挂载 allowlist 变更');
    try {
      return c.json(writeMountAllowlist(db, { allowedRoots: allowedRoots as MountAllowlist['allowedRoots'], blockedPatterns: blockedPatterns as string[] }));
    } finally {
      runnerLifecycle.resume();
    }
  });
  app.post('/recover', (c) => c.json({ runnerRuns: recoverRunnerRuns(db), taskRuns: recoverExpiredRuns(db, new Date(), 3) }));
  return app;
}
