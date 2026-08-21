import crypto from 'node:crypto';
import path from 'node:path';
import { createNodeWebSocket, type NodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import type { AgentRunner } from '@deep-worker/pi-runner';
import { PiRunner } from '@deep-worker/pi-runner';
import { DATA_DIR } from './config.js';
import { initDatabase } from './db/migration.js';
import { logger } from './logger.js';
import type { AppVariables } from './types.js';
import { createAdminRoutes } from './routes/admin.js';
import { createAgentProfileRoutes } from './routes/agent-profiles.js';
import { createAuthRoutes } from './routes/auth.js';
import { createChannelAccountRoutes } from './routes/channel-accounts.js';
import { createWorkspaceRoutes } from './routes/workspaces.js';
import { createRunnerRoutes } from './routes/runner.js';
import { createWorkspaceToolsRoutes } from './routes/workspace-tools.js';
import { RuntimeRunnerService } from './runtime-runner-service.js';
import { createCapabilityRoutes } from './routes/capabilities.js';
import { createTaskRoutes } from './routes/tasks.js';
import { createMemoryRoutes } from './routes/memory.js';
import { TaskService } from './task-service.js';

export type App = Hono<{ Variables: AppVariables }> & {
  close: () => Promise<void>;
  injectWebSocket: NodeWebSocket['injectWebSocket'];
};

export function createApp(
  options: {
    db?: Database.Database;
    runner?: AgentRunner;
    runnerService?: RuntimeRunnerService;
    taskService?: TaskService;
  } = {},
): App {
  const db = options.db ?? initDatabase(':memory:');
  const runner =
    options.runner ??
    new PiRunner({
      baseDir: path.join(DATA_DIR, 'pi-sessions'),
      queueOptions: { maxAttempts: 1 },
    });
  const runnerService = options.runnerService ?? new RuntimeRunnerService({ db, runner });
  const taskService = options.taskService ?? new TaskService({ db, runnerService });
  const app = new Hono<{ Variables: AppVariables }>();
  const nodeWebSocket = createNodeWebSocket({ app });
  const workspaceTools = createWorkspaceToolsRoutes(db, nodeWebSocket.upgradeWebSocket);
  app.use(async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
    c.set('requestId', requestId);
    c.header('x-request-id', requestId);
    const started = performance.now();
    await next();
    logger.info(
      {
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Math.round(performance.now() - started),
      },
      'request',
    );
  });

  app.get('/healthz', (c) => c.json({ status: 'ok', uptime: Math.round(process.uptime()) }));
  app.route('/api/auth', createAuthRoutes(db));
  app.route('/api/admin', createAdminRoutes(db));
  app.route('/api/agent-profiles', createAgentProfileRoutes(db));
  app.route('/api/workspaces', createWorkspaceRoutes(db));
  app.route(
    '/api/workspaces',
    createRunnerRoutes(db, runnerService, nodeWebSocket.upgradeWebSocket),
  );
  app.route('/api/workspaces', workspaceTools);
  app.route('/api/channel-accounts', createChannelAccountRoutes(db));
  app.route('/api/capabilities', createCapabilityRoutes(db));
  app.route('/api/tasks', createTaskRoutes(taskService, db));
  app.route('/api/workspaces', createMemoryRoutes(db));

  void runnerService.resumePending().catch((error) => {
    logger.error({ err: error }, 'Runner recovery failed');
  });
  taskService.start();
  return Object.assign(app, {
    close: async () => {
      await workspaceTools.close();
      await taskService.close();
      await runnerService.close();
    },
    injectWebSocket: nodeWebSocket.injectWebSocket,
  });
}
