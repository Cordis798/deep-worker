import crypto from 'node:crypto';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { initDatabase } from './db/migration.js';
import { logger } from './logger.js';
import type { AppVariables } from './types.js';
import { createAdminRoutes } from './routes/admin.js';
import { createAuthRoutes } from './routes/auth.js';

export type App = Hono<{ Variables: AppVariables }>;

export function createApp(options: { db?: Database.Database } = {}): App {
  const db = options.db ?? initDatabase(':memory:');
  const app = new Hono<{ Variables: AppVariables }>();
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

  app.get('/healthz', (c) =>
    c.json({ status: 'ok', uptime: Math.round(process.uptime()) }),
  );
  app.route('/api/auth', createAuthRoutes(db));
  app.route('/api/admin', createAdminRoutes(db));

  return app;
}
