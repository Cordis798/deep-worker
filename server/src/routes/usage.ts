import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { authMiddleware } from '../middleware/auth.js';
import { getUsageAnalytics, listUsageRecords, type UsageFilters } from '../usage-service.js';
import type { AppVariables } from '../types.js';

function validDate(value: string | undefined): value is string { if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const parsed = new Date(`${value}T00:00:00Z`); return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value; }

function filtersFor(c: { req: { query: (name: string) => string | undefined }; get: (key: 'user') => AppVariables['user'] }): UsageFilters {
  const user = c.get('user')!;
  const today = new Date();
  const rawTo = c.req.query('to');
  const rawFrom = c.req.query('from');
  if (rawFrom && !validDate(rawFrom)) throw new Error('起始日期格式无效，应为 YYYY-MM-DD');
  if (rawTo && !validDate(rawTo)) throw new Error('结束日期格式无效，应为 YYYY-MM-DD');
  const to = validDate(rawTo) ? rawTo : today.toISOString().slice(0, 10);
  const requestedDays = Number.parseInt(c.req.query('days') ?? '7', 10);
  const windowDays = Number.isInteger(requestedDays) ? Math.min(365, Math.max(1, requestedDays)) : 7;
  const defaultFrom = new Date(today.getTime() - (windowDays - 1) * 86400000).toISOString().slice(0, 10);
  const from = validDate(rawFrom) ? rawFrom : defaultFrom;
  if (from > to) throw new Error('起始日期不能晚于结束日期');
  const rangeDays = Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (rangeDays > 365) throw new Error('用量查询范围不能超过 365 天');
  return {
    from,
    to,
    userId: user.role === 'admin' ? c.req.query('userId') || undefined : user.id,
    workspaceJid: c.req.query('workspaceJid') || c.req.query('workspace') || undefined,
    agentId: c.req.query('agentId') || c.req.query('agent') || undefined,
    model: c.req.query('model') || undefined,
    source: c.req.query('source') || undefined,
  };
}

function csvCell(value: unknown): string {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function createUsageRoutes(db: Database.Database) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use('*', authMiddleware(db));

  app.get('/stats', (c) => {
    try {
      const filters = filtersFor(c);
      const result = getUsageAnalytics(db, filters);
      return c.json({ window: { from: filters.from, to: filters.to }, generatedAt: new Date().toISOString(), scope: filters, ...result });
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : '用量查询失败' }, 400); }
  });

  app.get('/records', (c) => {
    try {
      const filters = filtersFor(c);
      const page = Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1);
      const pageSize = Math.min(500, Math.max(1, Number.parseInt(c.req.query('pageSize') ?? '50', 10) || 50));
      const result = listUsageRecords(db, filters, page, pageSize);
      return c.json({ ...result, page, pageSize, totalPages: Math.ceil(result.total / pageSize), window: { from: filters.from, to: filters.to } });
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : '用量明细查询失败' }, 400); }
  });

  app.get('/models', (c) => {
    try {
      const filters = filtersFor(c);
      const result = getUsageAnalytics(db, filters);
      return c.json({ models: result.attributions.models });
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : '模型查询失败' }, 400); }
  });

  app.get('/export.csv', (c) => {
    try {
      const filters = filtersFor(c);
      const total = listUsageRecords(db, filters, 1, 1).total;
      if (total > 10_000) return c.json({ error: '导出记录超过 10000 条，请缩小筛选范围' }, 413);
      const rows = listUsageRecords(db, filters, 1, Math.max(1, total)).records as Array<Record<string, unknown>>;
      const columns = ['eventId', 'createdAt', 'userId', 'workspaceJid', 'agentId', 'source', 'model', 'inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'reasoningTokens', 'providerEstimatedCostUSD', 'billedCostUSD', 'durationMs', 'numTurns', 'messageId'];
      const csv = [columns.join(','), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(','))].join('\r\n');
      c.header('Content-Type', 'text/csv; charset=utf-8');
      c.header('Content-Disposition', `attachment; filename="deep-worker-usage-${filters.from}-${filters.to}.csv"`);
      return c.body(`\uFEFF${csv}`);
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : '用量导出失败' }, 400); }
  });

  return app;
}
