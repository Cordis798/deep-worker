import { describe, expect, it } from 'vitest';
import { initDatabase } from './db/migration.js';
import { createUser } from './users.js';
import { adjustBalance, assignPlan, checkBillingAccess, checkQuota, createBillingPlan, createRedeemCode, getBalance, redeemCode, setQuotaOverride } from './billing.js';
import { recordUsageEvent } from './usage-service.js';
import { createWorkspace } from './workspaces.js';

function fixture() {
  const db = initDatabase(':memory:');
  const timestamp = new Date().toISOString();
  createUser(db, { id: 'admin', username: 'admin', password_hash: 'x', display_name: '管理员', role: 'admin', status: 'active', created_at: timestamp, updated_at: timestamp });
  createUser(db, { id: 'member', username: 'member', password_hash: 'x', display_name: '成员', role: 'member', status: 'active', created_at: timestamp, updated_at: timestamp });
  const workspace = createWorkspace(db, 'member', { name: '计费工作区', folder: 'billing-fixture' })!;
  return { db, workspace };
}

describe('计费与配额', () => {
  it('兑换码和余额调整幂等，日度 Token 超限会阻断执行', () => {
    const { db, workspace } = fixture();
    createBillingPlan(db, { id: 'starter', name: '入门套餐', dailyTokenQuota: 5, allowOverage: true });
    assignPlan(db, 'member', 'starter', 'admin');
    const adjustment = adjustBalance(db, { userId: 'member', amountUSD: 10, description: '测试充值', actorUserId: 'admin', idempotencyKey: 'balance-once' });
    const replay = adjustBalance(db, { userId: 'member', amountUSD: 99, description: '不应重复', actorUserId: 'admin', idempotencyKey: 'balance-once' });
    expect(replay).toEqual(adjustment);
    createRedeemCode(db, { code: 'START-ONE', type: 'balance', valueUSD: 5, createdBy: 'admin' });
    expect(redeemCode(db, 'member', 'start-one').success).toBe(true);
    expect(redeemCode(db, 'member', 'START-ONE').success).toBe(false);
    expect(getBalance(db, 'member').balanceUSD).toBe(15);
    recordUsageEvent({ db, userId: 'member', workspaceJid: workspace.jid, eventId: 'quota-event', usage: { inputTokens: 6, outputTokens: 0 }, createdAt: '2026-08-21T10:00:00.000Z' });
    expect(checkQuota(db, 'member', 'member').allowed).toBe(false);
    expect(checkBillingAccess(db, 'member', 'member').blockType).toBe('quota_exceeded');
  });

  it('默认套餐切换不会触发唯一索引冲突，已被订阅的套餐不能删除', () => {
    const { db } = fixture();
    createBillingPlan(db, { id: 'pro', name: '专业套餐', isDefault: true });
    expect(db.prepare('SELECT id FROM billing_plans WHERE is_default = 1').get()).toEqual({ id: 'pro' });
    assignPlan(db, 'member', 'pro', 'admin');
    expect(() => db.prepare('DELETE FROM billing_plans WHERE id = ?').run('pro')).toThrow();
  });

  it('按 Agent 和 Workspace 分别执行配额检查', () => {
    const { db, workspace } = fixture();
    createBillingPlan(db, { id: 'unlimited', name: '不限量套餐', allowOverage: true });
    assignPlan(db, 'member', 'unlimited', 'admin');
    setQuotaOverride(db, { scopeType: 'agent', scopeId: 'agent-a', dailyTokenQuota: 5, dailyCostQuota: null, weeklyTokenQuota: null, weeklyCostQuota: null, monthlyTokenQuota: null, monthlyCostQuota: null });
    recordUsageEvent({ db, userId: 'member', workspaceJid: workspace.jid, agentId: 'agent-a', eventId: 'agent-quota-event', usage: { inputTokens: 6, outputTokens: 0 }, createdAt: '2026-08-21T10:00:00.000Z' });
    expect(checkQuota(db, 'member', 'member', { agentId: 'agent-a', workspaceJid: workspace.jid })).toMatchObject({ allowed: false, blockType: 'quota_exceeded' });
    expect(checkQuota(db, 'member', 'member', { agentId: 'agent-b', workspaceJid: workspace.jid })).toMatchObject({ allowed: true });

    setQuotaOverride(db, { scopeType: 'workspace', scopeId: workspace.jid, dailyTokenQuota: 5, dailyCostQuota: null, weeklyTokenQuota: null, weeklyCostQuota: null, monthlyTokenQuota: null, monthlyCostQuota: null });
    expect(checkBillingAccess(db, 'member', 'member', { agentId: 'agent-b', workspaceJid: workspace.jid })).toMatchObject({ allowed: false, blockType: 'quota_exceeded' });
  });
});
