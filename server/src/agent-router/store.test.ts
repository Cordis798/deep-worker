import { afterEach, describe, expect, it } from 'vitest';
import { initDatabase } from '../db/migration.js';
import { claimRouterTask, failRouterPlanForWorker, failRouterTasksForWorker, renewRouterTask, setRouterTaskStatus, verifyRouterPlanHash } from './store.js';

describe('agent router task lease fencing', () => {
  let db: ReturnType<typeof initDatabase> | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('拒绝父计划租约失效后的任务写回', () => {
    db = initDatabase(':memory:');
    const now = new Date();
    const createdAt = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + 60_000).toISOString();
    const userId = 'usr_lease';
    const profileId = 'ap_lease';
    const workspaceJid = 'ws_lease';
    const planId = 'arp_lease';
    const taskId = 'art_lease';
    db.prepare(
      `INSERT INTO users (id, username, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(userId, 'lease-test', 'not-a-password', createdAt, createdAt);
    db.prepare(
      `INSERT INTO agent_profiles (id, owner_user_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(profileId, userId, 'Lease Test Agent', createdAt, createdAt);
    db.prepare(
      `INSERT INTO workspaces (jid, folder, owner_user_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(workspaceJid, 'lease-test', userId, 'Lease Test', createdAt, createdAt);
    db.prepare(
      `INSERT INTO agent_router_plans (
        id, workspace_jid, actor_user_id, intent, status, input_json, route_json,
        created_at, updated_at, approval_required, approval_status
      ) VALUES (?, ?, ?, 'read', 'running', ?, ?, ?, ?, 0, 'not_required')`,
    ).run(planId, workspaceJid, userId, '{"message":"test"}', '{"intent":"read","requiredCapabilities":[],"tasks":[]}', createdAt, createdAt);
    db.prepare(
      `INSERT INTO agent_router_tasks (
        id, plan_id, ordinal, agent_profile_id, title, input_json, status,
        lease_owner, lease_expires_at, created_at, updated_at
      ) VALUES (?, ?, 0, ?, 'Lease task', ?, 'running', ?, ?, ?, ?)`,
    ).run(taskId, planId, profileId, '{"input":"test","dependsOn":[]}', userId, leaseExpiresAt, createdAt, createdAt);
    db.prepare(
      `UPDATE agent_router_plans
       SET dispatch_owner = ?, dispatch_lease_expires_at = ? WHERE id = ?`,
    ).run(userId, leaseExpiresAt, planId);

    expect(setRouterTaskStatus(db, taskId, 'completed', { text: 'ok' }, userId)).toBe(true);

    db.prepare(
      `UPDATE agent_router_tasks
       SET status = 'running', lease_owner = ?, lease_expires_at = ?, completed_at = NULL WHERE id = ?`,
    ).run(userId, leaseExpiresAt, taskId);
    db.prepare(
      `UPDATE agent_router_plans SET dispatch_lease_expires_at = ? WHERE id = ?`,
    ).run(new Date(now.getTime() - 1_000).toISOString(), planId);

    expect(setRouterTaskStatus(db, taskId, 'completed', { text: 'stale' }, userId)).toBe(false);
    expect((db.prepare('SELECT status, result_json FROM agent_router_tasks WHERE id = ?').get(taskId) as { status: string; result_json: string | null })).toEqual({ status: 'running', result_json: '{"text":"ok"}' });

    db.prepare(
      `UPDATE agent_router_tasks SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL WHERE id = ?`,
    ).run(taskId);
    expect(claimRouterTask(db, taskId, userId)).toBe(false);
    db.prepare(
      `UPDATE agent_router_plans SET dispatch_lease_expires_at = ? WHERE id = ?`,
    ).run(leaseExpiresAt, planId);
    expect(claimRouterTask(db, taskId, userId)).toBe(true);
    const claimed = db.prepare('SELECT lease_expires_at FROM agent_router_tasks WHERE id = ?').get(taskId) as { lease_expires_at: string };
    db.prepare(
      `UPDATE agent_router_plans SET dispatch_lease_expires_at = ? WHERE id = ?`,
    ).run(new Date(now.getTime() - 1_000).toISOString(), planId);
    expect(renewRouterTask(db, taskId, userId)).toBe(false);
    expect((db.prepare('SELECT lease_expires_at FROM agent_router_tasks WHERE id = ?').get(taskId) as { lease_expires_at: string }).lease_expires_at).toBe(claimed.lease_expires_at);
    expect(failRouterTasksForWorker(db, planId, userId, '租约失效')).toBe(1);
    expect(failRouterPlanForWorker(db, planId, userId)).toBe(true);
    expect((db.prepare('SELECT status, lease_owner, lease_expires_at FROM agent_router_tasks WHERE id = ?').get(taskId) as { status: string; lease_owner: string | null; lease_expires_at: string | null })).toEqual({ status: 'failed', lease_owner: null, lease_expires_at: null });
    expect((db.prepare('SELECT status, dispatch_owner, dispatch_lease_expires_at FROM agent_router_plans WHERE id = ?').get(planId) as { status: string; dispatch_owner: string | null; dispatch_lease_expires_at: string | null })).toEqual({ status: 'failed', dispatch_owner: null, dispatch_lease_expires_at: null });
  });

  it('校验审批计划完整性 hash', () => {
    const plan = {
      id: 'arp-hash',
      workspaceJid: 'ws-hash',
      sessionId: null,
      actorUserId: 'user-hash',
      intent: 'engineering',
      status: 'planned' as const,
      input: '请修复代码',
      route: {
        intent: 'engineering',
        requiredCapabilities: ['code'],
        tasks: [],
        fallback: 'reject' as const,
        explanation: '',
        risk: 'write' as const,
      },
      result: null,
      capabilityHash: 'capability-hash',
      createdAt: '',
      updatedAt: '',
      completedAt: null,
      planHash: null,
      approvalRequired: true,
      approvalStatus: 'pending' as const,
      approvalExpiresAt: null,
      approvedBy: null,
      approvedAt: null,
    };
    expect(verifyRouterPlanHash(plan)).toBe(false);
    expect(verifyRouterPlanHash({ ...plan, approvalRequired: false })).toBe(true);
  });
});
