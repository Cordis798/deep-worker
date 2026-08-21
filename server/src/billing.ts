import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

export interface BillingPlan {
  id: string;
  name: string;
  description: string | null;
  tier: number;
  monthlyCostUSD: number;
  monthlyTokenQuota: number | null;
  monthlyCostQuota: number | null;
  dailyTokenQuota: number | null;
  dailyCostQuota: number | null;
  weeklyTokenQuota: number | null;
  weeklyCostQuota: number | null;
  rateMultiplier: number;
  trialDays: number | null;
  sortOrder: number;
  displayPrice: string | null;
  highlight: boolean;
  allowOverage: boolean;
  features: string[];
  isDefault: boolean;
  isActive: boolean;
}

export interface BillingAccessResult {
  allowed: boolean;
  blockType?: 'plan_inactive' | 'insufficient_balance' | 'quota_exceeded';
  reason?: string;
  balanceUSD: number;
  minBalanceUSD: number;
  plan?: BillingPlan | null;
  exceededWindow?: 'daily' | 'weekly' | 'monthly';
  resetAt?: string;
  warningPercent?: number;
  usage?: QuotaUsage;
}

export interface QuotaUsage {
  dailyTokens: number;
  dailyCostUSD: number;
  weeklyTokens: number;
  weeklyCostUSD: number;
  monthlyTokens: number;
  monthlyCostUSD: number;
}

export interface RedeemCodeInput {
  code: string;
  type: 'balance' | 'subscription' | 'trial';
  valueUSD?: number | null;
  planId?: string | null;
  durationDays?: number | null;
  maxUses?: number;
  expiresAt?: string | null;
  createdBy: string;
  notes?: string | null;
  batchId?: string | null;
}

function rowToPlan(row: Record<string, unknown> | undefined): BillingPlan | null {
  if (!row) return null;
  let features: string[] = [];
  try { features = JSON.parse(String(row.features_json ?? '[]')) as string[]; } catch { features = []; }
  return {
    id: String(row.id), name: String(row.name), description: row.description == null ? null : String(row.description), tier: Number(row.tier ?? 0),
    monthlyCostUSD: Number(row.monthly_cost_usd ?? 0), monthlyTokenQuota: row.monthly_token_quota == null ? null : Number(row.monthly_token_quota), monthlyCostQuota: row.monthly_cost_quota == null ? null : Number(row.monthly_cost_quota),
    dailyTokenQuota: row.daily_token_quota == null ? null : Number(row.daily_token_quota), dailyCostQuota: row.daily_cost_quota == null ? null : Number(row.daily_cost_quota), weeklyTokenQuota: row.weekly_token_quota == null ? null : Number(row.weekly_token_quota), weeklyCostQuota: row.weekly_cost_quota == null ? null : Number(row.weekly_cost_quota),
    rateMultiplier: Number(row.rate_multiplier ?? 1), trialDays: row.trial_days == null ? null : Number(row.trial_days), sortOrder: Number(row.sort_order ?? 0), displayPrice: row.display_price == null ? null : String(row.display_price), highlight: Number(row.highlight) === 1, allowOverage: Number(row.allow_overage) === 1, features, isDefault: Number(row.is_default) === 1, isActive: Number(row.is_active) === 1,
  };
}

function now(): string { return new Date().toISOString(); }

export function isBillingEnabled(db: Database.Database): boolean {
  const row = db.prepare("SELECT value FROM config_kv WHERE key = 'billing_enabled'").get() as { value?: string } | undefined;
  return row?.value === undefined ? true : row.value === 'true';
}

export function setBillingEnabled(db: Database.Database, enabled: boolean): void {
  db.prepare(`INSERT INTO config_kv (key, value, updated_at) VALUES ('billing_enabled', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(String(enabled));
}

export function getBillingMinStartBalance(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM config_kv WHERE key = 'billing_min_start_balance_usd'").get() as { value?: string } | undefined;
  const value = Number(row?.value ?? 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function setBillingMinStartBalance(db: Database.Database, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error('最低余额必须是非负数');
  db.prepare(`INSERT INTO config_kv (key, value, updated_at) VALUES ('billing_min_start_balance_usd', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(String(value));
}

export function getBillingPlan(db: Database.Database, id: string): BillingPlan | null {
  return rowToPlan(db.prepare('SELECT * FROM billing_plans WHERE id = ?').get(id) as Record<string, unknown> | undefined);
}

export function listBillingPlans(db: Database.Database, activeOnly = false): BillingPlan[] {
  const rows = db.prepare(`SELECT * FROM billing_plans ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY sort_order ASC, tier ASC, name ASC`).all() as Array<Record<string, unknown>>;
  return rows.map((row) => rowToPlan(row)!).filter(Boolean);
}

export function createBillingPlan(db: Database.Database, input: Partial<BillingPlan> & Pick<BillingPlan, 'id' | 'name'>): BillingPlan {
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(input.id)) throw new Error('套餐 ID 格式无效');
  if (!input.name.trim()) throw new Error('套餐名称不能为空');
  const quotaValues = [input.monthlyTokenQuota, input.monthlyCostQuota, input.dailyTokenQuota, input.dailyCostQuota, input.weeklyTokenQuota, input.weeklyCostQuota];
  if (quotaValues.some((value) => value !== null && value !== undefined && (!Number.isInteger(value) || value < 0))) throw new Error('套餐配额必须是非负整数');
  if (input.rateMultiplier !== undefined && (!Number.isFinite(input.rateMultiplier) || input.rateMultiplier < 0)) throw new Error('计费倍率必须是非负数');
  const timestamp = now();
  db.transaction(() => {
    db.prepare(`INSERT INTO billing_plans (id, name, description, tier, monthly_cost_usd, monthly_token_quota, monthly_cost_quota, daily_token_quota, daily_cost_quota, weekly_token_quota, weekly_cost_quota, rate_multiplier, trial_days, sort_order, display_price, highlight, allow_overage, features_json, is_default, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`).run(
      input.id, input.name.trim(), input.description ?? null, input.tier ?? 0, input.monthlyCostUSD ?? 0, input.monthlyTokenQuota ?? null, input.monthlyCostQuota ?? null, input.dailyTokenQuota ?? null, input.dailyCostQuota ?? null, input.weeklyTokenQuota ?? null, input.weeklyCostQuota ?? null, input.rateMultiplier ?? 1, input.trialDays ?? null, input.sortOrder ?? 0, input.displayPrice ?? null, input.highlight ? 1 : 0, input.allowOverage ? 1 : 0, JSON.stringify(input.features ?? []), input.isActive === false ? 0 : 1, timestamp, timestamp,
    );
    if (input.isDefault) {
      db.prepare('UPDATE billing_plans SET is_default = 0').run();
      db.prepare('UPDATE billing_plans SET is_default = 1 WHERE id = ?').run(input.id);
    }
  })();
  return getBillingPlan(db, input.id)!;
}

export function updateBillingPlan(db: Database.Database, id: string, input: Partial<BillingPlan>): BillingPlan | null {
  const current = getBillingPlan(db, id);
  if (!current) return null;
  const fields: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => { fields.push(`${column} = ?`); values.push(value); };
  if (input.name !== undefined) set('name', input.name.trim());
  if (input.description !== undefined) set('description', input.description);
  if (input.monthlyTokenQuota !== undefined) set('monthly_token_quota', input.monthlyTokenQuota);
  if (input.monthlyCostQuota !== undefined) set('monthly_cost_quota', input.monthlyCostQuota);
  if (input.dailyTokenQuota !== undefined) set('daily_token_quota', input.dailyTokenQuota);
  if (input.dailyCostQuota !== undefined) set('daily_cost_quota', input.dailyCostQuota);
  if (input.weeklyTokenQuota !== undefined) set('weekly_token_quota', input.weeklyTokenQuota);
  if (input.weeklyCostQuota !== undefined) set('weekly_cost_quota', input.weeklyCostQuota);
  if (input.rateMultiplier !== undefined) set('rate_multiplier', input.rateMultiplier);
  if (input.allowOverage !== undefined) set('allow_overage', input.allowOverage ? 1 : 0);
  if (input.isActive !== undefined) set('is_active', input.isActive ? 1 : 0);
  if (input.features !== undefined) set('features_json', JSON.stringify(input.features));
  if (input.isDefault !== undefined) set('is_default', input.isDefault ? 1 : 0);
  if (!fields.length) return current;
  set('updated_at', now());
  values.push(id);
  db.transaction(() => {
    if (input.isDefault) db.prepare('UPDATE billing_plans SET is_default = 0').run();
    db.prepare(`UPDATE billing_plans SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  })();
  return getBillingPlan(db, id);
}

export function deleteBillingPlan(db: Database.Database, id: string): boolean {
  const plan = getBillingPlan(db, id);
  if (!plan || plan.isDefault) return false;
  if (db.prepare('SELECT 1 FROM user_subscriptions WHERE plan_id = ? LIMIT 1').get(id)) return false;
  return db.prepare('DELETE FROM billing_plans WHERE id = ?').run(id).changes === 1;
}

export function getUserEffectivePlan(db: Database.Database, userId: string): { plan: BillingPlan; subscription: Record<string, unknown> } | null {
  const timestamp = now();
  db.prepare("UPDATE user_subscriptions SET status = 'expired' WHERE user_id = ? AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?").run(userId, timestamp);
  const subscription = db.prepare("SELECT * FROM user_subscriptions WHERE user_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1").get(userId) as Record<string, unknown> | undefined;
  const plan = subscription ? getBillingPlan(db, String(subscription.plan_id)) : rowToPlan(db.prepare('SELECT * FROM billing_plans WHERE is_default = 1 AND is_active = 1 LIMIT 1').get() as Record<string, unknown> | undefined);
  return plan ? { plan, subscription: subscription ?? { id: `fallback_${userId}`, status: 'active', plan_id: plan.id } } : null;
}

export function assignPlan(db: Database.Database, userId: string, planId: string, actorUserId: string, durationDays?: number, trialDays?: number): Record<string, unknown> {
  const plan = getBillingPlan(db, planId);
  if (!plan || !plan.isActive) throw new Error('套餐不存在或未启用');
  const started = now();
  const expires = durationDays && durationDays > 0 ? new Date(Date.now() + durationDays * 86400000).toISOString() : null;
  const trialEnds = trialDays && trialDays > 0 ? new Date(Date.now() + trialDays * 86400000).toISOString() : null;
  const subscription = { id: `sub_${crypto.randomUUID()}`, userId, planId, status: 'active', startedAt: started, expiresAt: expires, trialEndsAt: trialEnds };
  db.transaction(() => {
    db.prepare("UPDATE user_subscriptions SET status = 'cancelled', cancelled_at = ? WHERE user_id = ? AND status = 'active'").run(started, userId);
    db.prepare('INSERT INTO user_subscriptions (id, user_id, plan_id, status, started_at, expires_at, trial_ends_at, created_at) VALUES (?, ?, ?, \'active\', ?, ?, ?, ?)').run(subscription.id, userId, planId, started, expires, trialEnds, started);
    writeBillingAudit(db, 'subscription_assigned', userId, actorUserId, { planId, durationDays: durationDays ?? null, trialDays: trialDays ?? null });
  })();
  return subscription;
}

export function cancelSubscription(db: Database.Database, userId: string, actorUserId: string): boolean {
  const changed = db.prepare("UPDATE user_subscriptions SET status = 'cancelled', cancelled_at = ? WHERE user_id = ? AND status = 'active'").run(now(), userId).changes > 0;
  if (changed) writeBillingAudit(db, 'subscription_cancelled', userId, actorUserId, {});
  return changed;
}

function mondayStart(date = new Date()): string {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() - day + 1);
  return value.toISOString().slice(0, 10);
}

function quotaUsage(db: Database.Database, userId: string): QuotaUsage {
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const week = mondayStart();
  const daily = db.prepare('SELECT total_input_tokens + total_output_tokens + total_cache_read_tokens + total_cache_creation_tokens + total_reasoning_tokens tokens, total_cost_usd cost FROM daily_usage WHERE user_id = ? AND date = ?').get(userId, today) as { tokens?: number; cost?: number } | undefined;
  const weekly = db.prepare('SELECT COALESCE(SUM(total_input_tokens + total_output_tokens + total_cache_read_tokens + total_cache_creation_tokens + total_reasoning_tokens), 0) tokens, COALESCE(SUM(total_cost_usd), 0) cost FROM daily_usage WHERE user_id = ? AND date >= ?').get(userId, week) as { tokens: number; cost: number };
  const monthly = db.prepare('SELECT total_input_tokens + total_output_tokens + total_cache_read_tokens + total_cache_creation_tokens + total_reasoning_tokens tokens, total_cost_usd cost FROM monthly_usage WHERE user_id = ? AND month = ?').get(userId, month) as { tokens?: number; cost?: number } | undefined;
  return { dailyTokens: daily?.tokens ?? 0, dailyCostUSD: daily?.cost ?? 0, weeklyTokens: weekly.tokens ?? 0, weeklyCostUSD: weekly.cost ?? 0, monthlyTokens: monthly?.tokens ?? 0, monthlyCostUSD: monthly?.cost ?? 0 };
}

export function checkQuota(db: Database.Database, userId: string, role: string): BillingAccessResult {
  if (role === 'admin' || !isBillingEnabled(db)) return { allowed: true, balanceUSD: getBalance(db, userId).balanceUSD, minBalanceUSD: getBillingMinStartBalance(db) };
  const effective = getUserEffectivePlan(db, userId);
  const usage = quotaUsage(db, userId);
  if (!effective) return { allowed: false, blockType: 'plan_inactive', reason: '未找到有效套餐，请联系管理员', balanceUSD: getBalance(db, userId).balanceUSD, minBalanceUSD: getBillingMinStartBalance(db), usage };
  const checks: Array<{ window: 'daily' | 'weekly' | 'monthly'; tokens: number; cost: number; tokenQuota: number | null; costQuota: number | null; resetAt: string }> = [
    { window: 'daily', tokens: usage.dailyTokens, cost: usage.dailyCostUSD, tokenQuota: effective.plan.dailyTokenQuota, costQuota: effective.plan.dailyCostQuota, resetAt: new Date(Date.now() + 86400000).toISOString() },
    { window: 'weekly', tokens: usage.weeklyTokens, cost: usage.weeklyCostUSD, tokenQuota: effective.plan.weeklyTokenQuota, costQuota: effective.plan.weeklyCostQuota, resetAt: new Date(Date.now() + 7 * 86400000).toISOString() },
    { window: 'monthly', tokens: usage.monthlyTokens, cost: usage.monthlyCostUSD, tokenQuota: effective.plan.monthlyTokenQuota, costQuota: effective.plan.monthlyCostQuota, resetAt: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toISOString() },
  ];
  for (const check of checks) {
    if ((check.tokenQuota !== null && check.tokens >= check.tokenQuota) || (check.costQuota !== null && check.cost >= check.costQuota)) {
      return { allowed: false, blockType: 'quota_exceeded', reason: `${check.window === 'daily' ? '日' : check.window === 'weekly' ? '周' : '月'}度配额已达上限`, balanceUSD: getBalance(db, userId).balanceUSD, minBalanceUSD: getBillingMinStartBalance(db), plan: effective.plan, exceededWindow: check.window, resetAt: check.resetAt, warningPercent: 100, usage };
    }
  }
  return { allowed: true, balanceUSD: getBalance(db, userId).balanceUSD, minBalanceUSD: getBillingMinStartBalance(db), plan: effective.plan, usage };
}

export function checkBillingAccess(db: Database.Database, userId: string, role: string): BillingAccessResult {
  const quota = checkQuota(db, userId, role);
  if (!quota.allowed) return quota;
  const minBalanceUSD = getBillingMinStartBalance(db);
  if (role !== 'admin' && isBillingEnabled(db) && quota.balanceUSD < minBalanceUSD) return { ...quota, allowed: false, blockType: 'insufficient_balance', reason: `余额不足，至少需要 $${minBalanceUSD.toFixed(2)}`, minBalanceUSD };
  return { ...quota, minBalanceUSD };
}

export function formatBillingAccessDeniedMessage(result: BillingAccessResult): string { return result.reason ?? '当前账户不可用'; }

export function getBalance(db: Database.Database, userId: string): { userId: string; balanceUSD: number; updatedAt: string | null } {
  const row = db.prepare('SELECT balance_usd, updated_at FROM user_balances WHERE user_id = ?').get(userId) as { balance_usd?: number; updated_at?: string } | undefined;
  return { userId, balanceUSD: row?.balance_usd ?? 0, updatedAt: row?.updated_at ?? null };
}

export function adjustBalance(db: Database.Database, input: { userId: string; amountUSD: number; description: string; actorUserId: string; idempotencyKey?: string; source?: string }): Record<string, unknown> {
  if (!Number.isFinite(input.amountUSD) || input.amountUSD === 0) throw new Error('余额变更金额无效');
  const existing = input.idempotencyKey ? db.prepare('SELECT * FROM balance_transactions WHERE idempotency_key = ?').get(input.idempotencyKey) as Record<string, unknown> | undefined : undefined;
  if (existing) return {
    id: existing.id,
    userId: existing.user_id,
    amountUSD: existing.amount_usd,
    balanceAfter: existing.balance_after,
    source: existing.source,
    description: existing.description,
    createdAt: existing.created_at,
  };
  const timestamp = now();
  return db.transaction(() => {
    const before = getBalance(db, input.userId).balanceUSD;
    const after = before + input.amountUSD;
    db.prepare(`INSERT INTO user_balances (user_id, balance_usd, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET balance_usd = excluded.balance_usd, updated_at = excluded.updated_at`).run(input.userId, after, timestamp);
    const id = `tx_${crypto.randomUUID()}`;
    db.prepare('INSERT INTO balance_transactions (id, user_id, amount_usd, balance_after, source, description, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, input.userId, input.amountUSD, after, input.source ?? 'admin_adjustment', input.description, input.idempotencyKey ?? null, timestamp);
    writeBillingAudit(db, 'balance_adjusted', input.userId, input.actorUserId, { amountUSD: input.amountUSD, description: input.description });
    return { id, userId: input.userId, amountUSD: input.amountUSD, balanceAfter: after, source: input.source ?? 'admin_adjustment', description: input.description, createdAt: timestamp };
  })();
}

export function listBalanceTransactions(db: Database.Database, userId: string, limit = 50, offset = 0): { transactions: unknown[]; total: number } {
  const total = (db.prepare('SELECT COUNT(*) count FROM balance_transactions WHERE user_id = ?').get(userId) as { count: number }).count;
  const transactions = db.prepare('SELECT id, user_id userId, amount_usd amountUSD, balance_after balanceAfter, source, description, created_at createdAt FROM balance_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(userId, limit, offset);
  return { transactions, total };
}

function writeBillingAudit(db: Database.Database, eventType: string, userId: string | null, actorUserId: string | null, details: Record<string, unknown>): void {
  db.prepare('INSERT INTO billing_audit_log (id, event_type, user_id, actor_user_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(`audit_${crypto.randomUUID()}`, eventType, userId, actorUserId, JSON.stringify(details), now());
}

export function createRedeemCode(db: Database.Database, input: RedeemCodeInput): Record<string, unknown> {
  if (!input.code.trim()) throw new Error('兑换码不能为空');
  if (input.type === 'balance' && (!input.valueUSD || input.valueUSD <= 0)) throw new Error('余额兑换码必须有正数金额');
  if (input.type !== 'balance' && !input.planId) throw new Error('套餐兑换码必须指定套餐');
  if (!Number.isInteger(input.maxUses ?? 1) || (input.maxUses ?? 1) < 1) throw new Error('兑换码次数必须是正整数');
  if (input.durationDays !== null && input.durationDays !== undefined && (!Number.isInteger(input.durationDays) || input.durationDays < 1)) throw new Error('兑换码时长必须是正整数');
  const code = input.code.trim().toUpperCase();
  db.prepare('INSERT INTO redeem_codes (code, type, value_usd, plan_id, duration_days, max_uses, expires_at, created_by, notes, batch_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(code, input.type, input.valueUSD ?? null, input.planId ?? null, input.durationDays ?? null, input.maxUses ?? 1, input.expiresAt ?? null, input.createdBy, input.notes ?? null, input.batchId ?? null, now());
  return getRedeemCode(db, code)!;
}

export function getRedeemCode(db: Database.Database, code: string): Record<string, unknown> | null {
  return (db.prepare('SELECT code, type, value_usd valueUSD, plan_id planId, duration_days durationDays, max_uses maxUses, used_count usedCount, expires_at expiresAt, notes, batch_id batchId, created_at createdAt FROM redeem_codes WHERE code = ?').get(code.trim().toUpperCase()) as Record<string, unknown> | undefined) ?? null;
}

export function listRedeemCodes(db: Database.Database): unknown[] { return db.prepare('SELECT code, type, value_usd valueUSD, plan_id planId, duration_days durationDays, max_uses maxUses, used_count usedCount, expires_at expiresAt, notes, batch_id batchId, created_at createdAt FROM redeem_codes ORDER BY created_at DESC').all(); }

export function deleteRedeemCode(db: Database.Database, code: string): boolean { return db.prepare('DELETE FROM redeem_codes WHERE code = ?').run(code.trim().toUpperCase()).changes === 1; }

export function redeemCode(db: Database.Database, userId: string, codeInput: string): { success: boolean; message: string } {
  const code = codeInput.trim().toUpperCase();
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM redeem_codes WHERE code = ?').get(code) as { type: string; value_usd: number | null; plan_id: string | null; duration_days: number | null; max_uses: number; used_count: number; expires_at: string | null } | undefined;
    if (!row) return { success: false, message: '兑换码不存在' };
    if (row.expires_at && row.expires_at <= now()) return { success: false, message: '兑换码已过期' };
    if (row.used_count >= row.max_uses) return { success: false, message: '兑换码已用尽' };
    if (db.prepare('SELECT 1 FROM redeem_code_usage WHERE code = ? AND user_id = ?').get(code, userId)) return { success: false, message: '你已经使用过该兑换码' };
    const changed = db.prepare('UPDATE redeem_codes SET used_count = used_count + 1 WHERE code = ? AND used_count < max_uses').run(code).changes;
    if (changed !== 1) return { success: false, message: '兑换码已用尽' };
    db.prepare('INSERT INTO redeem_code_usage (code, user_id, used_at) VALUES (?, ?, ?)').run(code, userId, now());
    if (row.type === 'balance') adjustBalance(db, { userId, amountUSD: row.value_usd ?? 0, description: '兑换码充值', actorUserId: userId, source: 'redeem_code', idempotencyKey: `redeem:${code}:${userId}` });
    else if (row.plan_id) assignPlan(db, userId, row.plan_id, userId, row.duration_days ?? undefined, row.type === 'trial' ? row.duration_days ?? undefined : undefined);
    writeBillingAudit(db, 'redeem_code_used', userId, userId, { code, type: row.type });
    return { success: true, message: '兑换成功' };
  })();
}

export function getDailyUsageHistory(db: Database.Database, userId: string, days = 14): unknown[] { return db.prepare('SELECT date, total_input_tokens inputTokens, total_output_tokens outputTokens, total_cache_read_tokens cacheReadTokens, total_cache_creation_tokens cacheCreationTokens, total_reasoning_tokens reasoningTokens, total_cost_usd costUSD, message_count messageCount FROM daily_usage WHERE user_id = ? ORDER BY date DESC LIMIT ?').all(userId, days); }

export function getBillingAuditLog(db: Database.Database, limit = 50): unknown[] { return db.prepare('SELECT id, event_type eventType, user_id userId, actor_user_id actorUserId, details_json details, created_at createdAt FROM billing_audit_log ORDER BY created_at DESC LIMIT ?').all(limit); }
