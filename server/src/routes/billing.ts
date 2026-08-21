import crypto from 'node:crypto';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { authMiddleware, requirePermission } from '../middleware/auth.js';
import {
  adjustBalance, assignPlan, cancelSubscription, checkBillingAccess, checkQuota, createBillingPlan, createRedeemCode, deleteBillingPlan, deleteRedeemCode, getBalance, getBillingAuditLog, getBillingMinStartBalance, getBillingPlan, getDailyUsageHistory, getUserEffectivePlan, isBillingEnabled, listBalanceTransactions, listBillingPlans, listRedeemCodes, redeemCode, setBillingEnabled, setBillingMinStartBalance, updateBillingPlan,
} from '../billing.js';
import { getUserById, listUsers } from '../users.js';
import type { AppVariables } from '../types.js';

function numberOrNull(value: unknown): number | null { return value === null || value === undefined || value === '' ? null : Number(value); }

export function createBillingRoutes(db: Database.Database) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use('*', authMiddleware(db));

  app.get('/status', (c) => c.json({ enabled: isBillingEnabled(db), minStartBalanceUSD: getBillingMinStartBalance(db), currency: 'USD' }));
  app.get('/plans', (c) => c.json({ plans: listBillingPlans(db, true) }));
  app.get('/my/summary', (c) => {
    const user = c.get('user')!;
    const effective = getUserEffectivePlan(db, user.id);
    return c.json({ balance: getBalance(db, user.id), plan: effective?.plan ?? null, subscription: effective?.subscription ?? null, access: checkBillingAccess(db, user.id, user.role), usage: getDailyUsageHistory(db, user.id, 14), transactions: listBalanceTransactions(db, user.id, 20, 0).transactions });
  });
  app.get('/my/quota', (c) => { const user = c.get('user')!; return c.json(checkQuota(db, user.id, user.role)); });
  app.get('/my/access', (c) => { const user = c.get('user')!; return c.json(checkBillingAccess(db, user.id, user.role)); });
  app.get('/my/daily', (c) => { const user = c.get('user')!; return c.json({ history: getDailyUsageHistory(db, user.id, Math.min(90, Math.max(1, Number(c.req.query('days') ?? 14)))) }); });
  app.get('/my/transactions', (c) => { const user = c.get('user')!; return c.json(listBalanceTransactions(db, user.id, Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 50))), Math.max(0, Number(c.req.query('offset') ?? 0)))); });
  app.post('/my/redeem', async (c) => { const user = c.get('user')!; const body = await c.req.json().catch(() => ({})) as { code?: string }; if (!body.code) return c.json({ error: '兑换码不能为空' }, 400); const result = redeemCode(db, user.id, body.code); return result.success ? c.json(result) : c.json(result, 400); });
  app.post('/my/cancel-subscription', (c) => { const user = c.get('user')!; return c.json({ success: cancelSubscription(db, user.id, user.id) }); });

  const manage = requirePermission('manage_billing');
  app.get('/admin/plans', manage, (c) => c.json({ plans: listBillingPlans(db) }));
  app.post('/admin/plans', manage, async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    try {
      const plan = createBillingPlan(db, { id: String(body.id ?? ''), name: String(body.name ?? ''), description: typeof body.description === 'string' ? body.description : null, monthlyCostUSD: Number(body.monthlyCostUSD ?? body.monthly_cost_usd ?? 0), monthlyTokenQuota: numberOrNull(body.monthlyTokenQuota ?? body.monthly_token_quota), monthlyCostQuota: numberOrNull(body.monthlyCostQuota ?? body.monthly_cost_quota), dailyTokenQuota: numberOrNull(body.dailyTokenQuota ?? body.daily_token_quota), dailyCostQuota: numberOrNull(body.dailyCostQuota ?? body.daily_cost_quota), weeklyTokenQuota: numberOrNull(body.weeklyTokenQuota ?? body.weekly_token_quota), weeklyCostQuota: numberOrNull(body.weeklyCostQuota ?? body.weekly_cost_quota), rateMultiplier: Number(body.rateMultiplier ?? body.rate_multiplier ?? 1), allowOverage: body.allowOverage === true || body.allow_overage === true, features: Array.isArray(body.features) ? body.features.filter((item): item is string => typeof item === 'string') : [], isDefault: body.isDefault === true || body.is_default === true });
      return c.json({ plan }, 201);
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : '套餐创建失败' }, 400); }
  });
  app.patch('/admin/plans/:id', manage, async (c) => { const body = await c.req.json().catch(() => ({})) as Record<string, unknown>; const plan = updateBillingPlan(db, c.req.param('id'), { name: typeof body.name === 'string' ? body.name : undefined, dailyTokenQuota: numberOrNull(body.dailyTokenQuota), dailyCostQuota: numberOrNull(body.dailyCostQuota), weeklyTokenQuota: numberOrNull(body.weeklyTokenQuota), weeklyCostQuota: numberOrNull(body.weeklyCostQuota), monthlyTokenQuota: numberOrNull(body.monthlyTokenQuota), monthlyCostQuota: numberOrNull(body.monthlyCostQuota), rateMultiplier: body.rateMultiplier === undefined ? undefined : Number(body.rateMultiplier), allowOverage: typeof body.allowOverage === 'boolean' ? body.allowOverage : undefined, isActive: typeof body.isActive === 'boolean' ? body.isActive : undefined }); return plan ? c.json({ plan }) : c.json({ error: '套餐不存在' }, 404); });
  app.delete('/admin/plans/:id', manage, (c) => deleteBillingPlan(db, c.req.param('id')) ? c.json({ success: true }) : c.json({ error: '默认套餐或不存在的套餐不能删除' }, 409));
  app.get('/admin/users', manage, (c) => c.json({ users: listUsers(db, { role: 'all', status: 'all' }).map((user) => ({ id: user.id, username: user.username, displayName: user.display_name, role: user.role, balance: getBalance(db, user.id), plan: getUserEffectivePlan(db, user.id)?.plan ?? null, access: checkBillingAccess(db, user.id, user.role) })) }));
  app.post('/admin/users/:id/assign-plan', manage, async (c) => { const actor = c.get('user')!; if (!getUserById(db, c.req.param('id'))) return c.json({ error: '用户不存在' }, 404); const body = await c.req.json().catch(() => ({})) as Record<string, unknown>; try { return c.json({ subscription: assignPlan(db, c.req.param('id'), String(body.planId ?? body.plan_id ?? ''), actor.id, numberOrNull(body.durationDays ?? body.duration_days) ?? undefined, numberOrNull(body.trialDays ?? body.trial_days) ?? undefined) }); } catch (error) { return c.json({ error: error instanceof Error ? error.message : '分配套餐失败' }, 400); } });
  app.post('/admin/users/:id/adjust-balance', manage, async (c) => { const actor = c.get('user')!; const body = await c.req.json().catch(() => ({})) as Record<string, unknown>; try { return c.json(adjustBalance(db, { userId: c.req.param('id'), actorUserId: actor.id, amountUSD: Number(body.amountUSD ?? body.amount_usd), description: String(body.description ?? '管理员余额调整'), idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : typeof body.idempotency_key === 'string' ? body.idempotency_key : undefined })); } catch (error) { return c.json({ error: error instanceof Error ? error.message : '余额调整失败' }, 400); } });
  app.post('/admin/users/:id/cancel-subscription', manage, (c) => c.json({ success: cancelSubscription(db, c.req.param('id'), c.get('user')!.id) }));
  app.get('/admin/redeem-codes', manage, (c) => c.json({ codes: listRedeemCodes(db) }));
  app.post('/admin/redeem-codes', manage, async (c) => { const actor = c.get('user')!; const body = await c.req.json().catch(() => ({})) as Record<string, unknown>; try { const count = Math.min(100, Math.max(1, Number(body.count ?? 1))); const codes = []; for (let index = 0; index < count; index += 1) { codes.push(createRedeemCode(db, { code: `${String(body.prefix ?? 'DW').toUpperCase()}-${crypto.randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`, type: body.type === 'balance' || body.type === 'trial' ? body.type : 'subscription', valueUSD: numberOrNull(body.valueUSD ?? body.value_usd), planId: typeof body.planId === 'string' ? body.planId : typeof body.plan_id === 'string' ? body.plan_id : null, durationDays: numberOrNull(body.durationDays ?? body.duration_days), maxUses: Number(body.maxUses ?? body.max_uses ?? 1), expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null, createdBy: actor.id, notes: typeof body.notes === 'string' ? body.notes : null })); } return c.json({ codes }, 201); } catch (error) { return c.json({ error: error instanceof Error ? error.message : '兑换码创建失败' }, 400); } });
  app.delete('/admin/redeem-codes/:code', manage, (c) => deleteRedeemCode(db, c.req.param('code')) ? c.json({ success: true }) : c.json({ error: '兑换码不存在' }, 404));
  app.get('/admin/audit-log', manage, (c) => c.json({ logs: getBillingAuditLog(db, Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50)))) }));
  app.patch('/admin/settings', manage, async (c) => { const body = await c.req.json().catch(() => ({})) as Record<string, unknown>; if (typeof body.enabled === 'boolean') setBillingEnabled(db, body.enabled); if (body.minStartBalanceUSD !== undefined) setBillingMinStartBalance(db, Number(body.minStartBalanceUSD)); return c.json({ enabled: isBillingEnabled(db), minStartBalanceUSD: getBillingMinStartBalance(db) }); });
  return app;
}
