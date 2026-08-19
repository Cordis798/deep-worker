import crypto from 'node:crypto';
import { Hono } from 'hono';
import { logger } from './logger.js';

type AppEnv = {
  Variables: {
    requestId: string;
  };
};

export type App = Hono<AppEnv>;

export function createApp(): App {
  const app = new Hono<AppEnv>();

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

  return app;
}
