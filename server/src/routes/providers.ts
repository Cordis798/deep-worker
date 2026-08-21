import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import {
  createProviderConfig,
  deleteProviderConfig,
  getProviderBalance,
  getProviderConfig,
  listProviderConfigs,
  setProviderBalance,
  toProviderPublic,
  updateProviderConfig,
} from '../provider-store.js';
import type Database from 'better-sqlite3';
import type { AppVariables } from '../types.js';

function inputFromBody(body: Record<string, unknown>) {
  return {
    name: typeof body.name === 'string' ? body.name : '',
    provider: typeof body.provider === 'string' ? body.provider : '',
    modelId: typeof body.model_id === 'string' ? body.model_id : '',
    baseUrl: typeof body.base_url === 'string' ? body.base_url : body.base_url === null ? null : undefined,
    credentials: body.credentials && typeof body.credentials === 'object' && !Array.isArray(body.credentials) ? body.credentials as Record<string, unknown> : undefined,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    weight: typeof body.weight === 'number' ? body.weight : undefined,
  };
}

export function createProviderRoutes(db: Database.Database) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use('*', authMiddleware(db));

  app.get('/', (c) => {
    const user = c.get('user')!;
    return c.json({ providers: listProviderConfigs(db, user.id).map(toProviderPublic), balancing: getProviderBalance(db, user.id) });
  });

  app.post('/', async (c) => {
    const user = c.get('user')!;
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    try {
      const row = createProviderConfig(db, user.id, inputFromBody(body));
      return c.json({ provider: toProviderPublic(row) }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Provider 配置无效' }, 400);
    }
  });

  app.patch('/:id', async (c) => {
    const user = c.get('user')!;
    if (!getProviderConfig(db, user.id, c.req.param('id'))) return c.json({ error: 'Provider 不存在' }, 404);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    try {
      const row = updateProviderConfig(db, user.id, c.req.param('id'), inputFromBody(body));
      return row ? c.json({ provider: toProviderPublic(row) }) : c.json({ error: 'Provider 不存在' }, 404);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Provider 配置无效' }, 400);
    }
  });

  app.delete('/:id', (c) => deleteProviderConfig(db, c.get('user')!.id, c.req.param('id')) ? c.json({ success: true }) : c.json({ error: 'Provider 不存在' }, 404));

  app.put('/balancing', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const strategy = body.strategy;
    if (strategy !== 'round-robin' && strategy !== 'weighted' && strategy !== 'failover') return c.json({ error: 'Provider 策略无效' }, 400);
    const unhealthyThreshold = Number(body.unhealthy_threshold);
    const recoveryIntervalMs = Number(body.recovery_interval_ms);
    if (!Number.isInteger(unhealthyThreshold) || unhealthyThreshold < 1 || !Number.isInteger(recoveryIntervalMs) || recoveryIntervalMs < 1_000) return c.json({ error: 'Provider 健康参数无效' }, 400);
    return c.json({ balancing: setProviderBalance(db, c.get('user')!.id, { strategy, unhealthyThreshold, recoveryIntervalMs }) });
  });

  return app;
}
