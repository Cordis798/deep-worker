import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { getUserEffectivePlan, isBillingEnabled } from './billing.js';
import { getUserById } from './users.js';
import { priceUsageByModel, type TokenUsage } from './kaboo-pricing.js';

export interface UsagePayload extends Partial<TokenUsage> {
  costUSD?: number;
  durationMs?: number;
  numTurns?: number;
  modelUsage?: Record<string, Partial<TokenUsage>>;
}

export interface RecordUsageEventOptions {
  db: Database.Database;
  userId: string;
  workspaceJid: string;
  agentId?: string | null;
  messageId?: string | null;
  source?: string;
  usage: UsagePayload;
  eventId?: string;
  model?: string;
  createdAt?: string;
}

function eventIdFor(input: RecordUsageEventOptions): string {
  if (input.eventId?.trim()) return input.eventId.trim();
  return `usage:${crypto.createHash('sha256').update(JSON.stringify({
    userId: input.userId,
    workspaceJid: input.workspaceJid,
    agentId: input.agentId ?? null,
    messageId: input.messageId ?? null,
    source: input.source ?? 'agent',
    usage: input.usage,
  })).digest('hex')}`;
}

function dateParts(createdAt: string): { date: string; month: string } {
  return { date: createdAt.slice(0, 10), month: createdAt.slice(0, 7) };
}

function addUsage(db: Database.Database, table: 'daily_usage' | 'monthly_usage', key: string, input: { userId: string; input: number; output: number; cacheRead: number; cacheCreation: number; reasoning: number; cost: number; now: string }): void {
  const column = table === 'daily_usage' ? 'date' : 'month';
  db.prepare(`
    INSERT INTO ${table} (user_id, ${column}, total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_creation_tokens, total_reasoning_tokens, total_cost_usd, message_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(user_id, ${column}) DO UPDATE SET
      total_input_tokens = total_input_tokens + excluded.total_input_tokens,
      total_output_tokens = total_output_tokens + excluded.total_output_tokens,
      total_cache_read_tokens = total_cache_read_tokens + excluded.total_cache_read_tokens,
      total_cache_creation_tokens = total_cache_creation_tokens + excluded.total_cache_creation_tokens,
      total_reasoning_tokens = total_reasoning_tokens + excluded.total_reasoning_tokens,
      total_cost_usd = total_cost_usd + excluded.total_cost_usd,
      message_count = message_count + 1,
      updated_at = excluded.updated_at
  `).run(input.userId, key, input.input, input.output, input.cacheRead, input.cacheCreation, input.reasoning, input.cost, input.now);
}

export function recordUsageEvent(input: RecordUsageEventOptions): { eventId: string; inserted: boolean; providerEstimatedCostUSD: number; billedCostUSD: number | null } {
  const eventId = eventIdFor(input);
  const existing = input.db.prepare('SELECT provider_estimated_cost_usd, billed_cost_usd FROM usage_events WHERE event_id = ?').get(eventId) as { provider_estimated_cost_usd: number; billed_cost_usd: number | null } | undefined;
  if (existing) return { eventId, inserted: false, providerEstimatedCostUSD: existing.provider_estimated_cost_usd, billedCostUSD: existing.billed_cost_usd };
  const createdAt = input.createdAt ?? new Date().toISOString();
  const priced = priceUsageByModel(input.usage, input.usage.modelUsage ?? (input.model ? { [input.model]: input.usage } : undefined));
  const user = getUserById(input.db, input.userId);
  const effective = user ? getUserEffectivePlan(input.db, input.userId) : null;
  const shouldBill = Boolean(user && user.role !== 'admin' && isBillingEnabled(input.db) && effective);
  const rate = shouldBill ? effective!.plan.rateMultiplier : 0;
  const billedCostUSD = shouldBill ? priced.costUSD * rate : null;
  const { date, month } = dateParts(createdAt);
  const source = input.source?.trim() || 'agent';
  const durationMs = Math.max(0, Math.trunc(input.usage.durationMs ?? 0));
  const numTurns = Math.max(1, Math.trunc(input.usage.numTurns ?? 1));
  const transaction = input.db.transaction(() => {
    const inserted = input.db.prepare(`INSERT OR IGNORE INTO usage_events
      (event_id, user_id, workspace_jid, agent_id, message_id, source, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, reasoning_tokens, provider_estimated_cost_usd, billed_cost_usd, duration_ms, num_turns, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(eventId, input.userId, input.workspaceJid, input.agentId ?? null, input.messageId ?? null, source, priced.usage.inputTokens, priced.usage.outputTokens, priced.usage.cacheReadInputTokens, priced.usage.cacheCreationInputTokens, priced.usage.reasoningTokens, priced.costUSD, billedCostUSD, durationMs, numTurns, createdAt).changes;
    if (inserted === 0) return false;
    for (const model of priced.models) {
      const modelBilled = shouldBill ? model.providerEstimatedCostUSD * rate : null;
      input.db.prepare(`INSERT INTO usage_event_models (event_id, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, reasoning_tokens, provider_estimated_cost_usd, billed_cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(eventId, model.model, model.inputTokens, model.outputTokens, model.cacheReadInputTokens, model.cacheCreationInputTokens, model.reasoningTokens, model.providerEstimatedCostUSD, modelBilled);
      input.db.prepare(`INSERT INTO usage_daily_summary (user_id, workspace_jid, agent_id, model, date, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, reasoning_tokens, provider_estimated_cost_usd, billed_cost_usd, run_count, model_call_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
        ON CONFLICT(user_id, workspace_jid, agent_id, model, date) DO UPDATE SET
          input_tokens = input_tokens + excluded.input_tokens,
          output_tokens = output_tokens + excluded.output_tokens,
          cache_read_input_tokens = cache_read_input_tokens + excluded.cache_read_input_tokens,
          cache_creation_input_tokens = cache_creation_input_tokens + excluded.cache_creation_input_tokens,
          reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
          provider_estimated_cost_usd = provider_estimated_cost_usd + excluded.provider_estimated_cost_usd,
          billed_cost_usd = COALESCE(billed_cost_usd, 0) + COALESCE(excluded.billed_cost_usd, 0),
          run_count = run_count + 1,
          model_call_count = model_call_count + 1`)
        .run(input.userId, input.workspaceJid, input.agentId ?? '', model.model, date, model.inputTokens, model.outputTokens, model.cacheReadInputTokens, model.cacheCreationInputTokens, model.reasoningTokens, model.providerEstimatedCostUSD, modelBilled);
    }
    addUsage(input.db, 'daily_usage', date, { userId: input.userId, input: priced.usage.inputTokens, output: priced.usage.outputTokens, cacheRead: priced.usage.cacheReadInputTokens, cacheCreation: priced.usage.cacheCreationInputTokens, reasoning: priced.usage.reasoningTokens, cost: priced.costUSD, now: createdAt });
    addUsage(input.db, 'monthly_usage', month, { userId: input.userId, input: priced.usage.inputTokens, output: priced.usage.outputTokens, cacheRead: priced.usage.cacheReadInputTokens, cacheCreation: priced.usage.cacheCreationInputTokens, reasoning: priced.usage.reasoningTokens, cost: priced.costUSD, now: createdAt });
    if (shouldBill && billedCostUSD && billedCostUSD > 0) {
      const balance = input.db.prepare('SELECT balance_usd FROM user_balances WHERE user_id = ?').get(input.userId) as { balance_usd: number } | undefined;
      const current = balance?.balance_usd ?? 0;
      if (!effective!.plan.allowOverage && current < billedCostUSD) throw new Error('余额不足');
      const next = current - billedCostUSD;
      input.db.prepare(`INSERT INTO user_balances (user_id, balance_usd, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET balance_usd = excluded.balance_usd, updated_at = excluded.updated_at`).run(input.userId, next, createdAt);
      input.db.prepare(`INSERT INTO balance_transactions (id, user_id, amount_usd, balance_after, source, description, reference_id, created_at) VALUES (?, ?, ?, ?, 'usage', 'Agent 用量扣费', ?, ?)`).run(`tx_${crypto.randomUUID()}`, input.userId, -billedCostUSD, next, eventId, createdAt);
    }
    return true;
  })();
  return { eventId, inserted: transaction, providerEstimatedCostUSD: priced.costUSD, billedCostUSD };
}

export interface UsageFilters { userId?: string; workspaceJid?: string; agentId?: string; model?: string; source?: string; from: string; to: string; }

export function getUsageAnalytics(db: Database.Database, filters: UsageFilters) {
  const where = ['e.created_at >= ?', 'e.created_at < ?'];
  const params: unknown[] = [`${filters.from}T00:00:00.000Z`, `${filters.to}T23:59:59.999Z`];
  if (filters.userId) { where.push('e.user_id = ?'); params.push(filters.userId); }
  if (filters.workspaceJid) { where.push('e.workspace_jid = ?'); params.push(filters.workspaceJid); }
  if (filters.agentId) { where.push('COALESCE(e.agent_id, \'\') = ?'); params.push(filters.agentId); }
  if (filters.source) { where.push('e.source = ?'); params.push(filters.source); }
  if (filters.model) { where.push('m.model = ?'); params.push(filters.model); }
  const clause = where.join(' AND ');
  const summary = db.prepare(`SELECT COALESCE(SUM(m.input_tokens), 0) inputTokens, COALESCE(SUM(m.output_tokens), 0) outputTokens, COALESCE(SUM(m.cache_read_input_tokens), 0) cacheReadInputTokens, COALESCE(SUM(m.cache_creation_input_tokens), 0) cacheCreationInputTokens, COALESCE(SUM(m.reasoning_tokens), 0) reasoningTokens, COALESCE(SUM(m.provider_estimated_cost_usd), 0) providerEstimatedCostUSD, COALESCE(SUM(m.billed_cost_usd), 0) billedCostUSD, COUNT(DISTINCT e.event_id) runCount, COUNT(m.model) modelCallCount, COUNT(DISTINCT substr(e.created_at, 1, 10)) activeDays FROM usage_events e JOIN usage_event_models m ON m.event_id = e.event_id WHERE ${clause}`).get(...params) as Record<string, number>;
  const breakdown = db.prepare(`SELECT substr(e.created_at, 1, 10) date, m.model, m.input_tokens, m.output_tokens, m.cache_read_input_tokens, m.cache_creation_input_tokens, m.reasoning_tokens, m.provider_estimated_cost_usd, m.billed_cost_usd, COUNT(DISTINCT e.event_id) run_count, COUNT(m.model) model_call_count FROM usage_events e JOIN usage_event_models m ON m.event_id = e.event_id WHERE ${clause} GROUP BY date, m.model ORDER BY date ASC, m.model ASC`).all(...params);
  const attributions = {
    models: db.prepare(`SELECT m.model key, m.model label, SUM(m.input_tokens + m.output_tokens + m.cache_read_input_tokens + m.cache_creation_input_tokens + m.reasoning_tokens) tokens, SUM(m.provider_estimated_cost_usd) estimatedCost, SUM(COALESCE(m.billed_cost_usd, 0)) billedCost, COUNT(DISTINCT e.event_id) runCount FROM usage_events e JOIN usage_event_models m ON m.event_id = e.event_id WHERE ${clause} GROUP BY m.model ORDER BY tokens DESC`).all(...params),
    agents: db.prepare(`SELECT COALESCE(e.agent_id, '') key, COALESCE(e.agent_id, '未指定 Agent') label, SUM(m.input_tokens + m.output_tokens + m.cache_read_input_tokens + m.cache_creation_input_tokens + m.reasoning_tokens) tokens, SUM(m.provider_estimated_cost_usd) estimatedCost, COUNT(DISTINCT e.event_id) runCount FROM usage_events e JOIN usage_event_models m ON m.event_id = e.event_id WHERE ${clause} GROUP BY e.agent_id ORDER BY tokens DESC`).all(...params),
    workspaces: db.prepare(`SELECT e.workspace_jid key, e.workspace_jid label, SUM(m.input_tokens + m.output_tokens + m.cache_read_input_tokens + m.cache_creation_input_tokens + m.reasoning_tokens) tokens, SUM(m.provider_estimated_cost_usd) estimatedCost, COUNT(DISTINCT e.event_id) runCount FROM usage_events e JOIN usage_event_models m ON m.event_id = e.event_id WHERE ${clause} GROUP BY e.workspace_jid ORDER BY tokens DESC`).all(...params),
  };
  return { summary, breakdown, daily: breakdown, attributions };
}

export function listUsageRecords(db: Database.Database, filters: UsageFilters, page: number, pageSize: number) {
  const where = ['e.created_at >= ?', 'e.created_at < ?'];
  const params: unknown[] = [`${filters.from}T00:00:00.000Z`, `${filters.to}T23:59:59.999Z`];
  if (filters.userId) { where.push('e.user_id = ?'); params.push(filters.userId); }
  if (filters.workspaceJid) { where.push('e.workspace_jid = ?'); params.push(filters.workspaceJid); }
  if (filters.agentId) { where.push('COALESCE(e.agent_id, \'\') = ?'); params.push(filters.agentId); }
  if (filters.source) { where.push('e.source = ?'); params.push(filters.source); }
  if (filters.model) { where.push('m.model = ?'); params.push(filters.model); }
  const clause = where.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) count FROM usage_events e JOIN usage_event_models m ON m.event_id = e.event_id WHERE ${clause}`).get(...params) as { count: number }).count;
  const rows = db.prepare(`SELECT e.event_id eventId, e.created_at createdAt, e.user_id userId, e.workspace_jid workspaceJid, e.agent_id agentId, e.source, m.model, m.input_tokens inputTokens, m.output_tokens outputTokens, m.cache_read_input_tokens cacheReadInputTokens, m.cache_creation_input_tokens cacheCreationInputTokens, m.reasoning_tokens reasoningTokens, m.provider_estimated_cost_usd providerEstimatedCostUSD, m.billed_cost_usd billedCostUSD, e.duration_ms durationMs, e.num_turns numTurns, e.message_id messageId FROM usage_events e JOIN usage_event_models m ON m.event_id = e.event_id WHERE ${clause} ORDER BY e.created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
  return { records: rows, total };
}
