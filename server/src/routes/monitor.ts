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
  app.post('/recover', (c) => c.json({ runnerRuns: recoverRunnerRuns(db), taskRuns: recoverExpiredRuns(db, new Date(), 3) }));
  return app;
}
