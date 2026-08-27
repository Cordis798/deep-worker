import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { canWorkspaceAction } from '../workspace-acl.js';
import { AgentRouterService, RouterApprovalRequiredError, RouterDispatchBusyError } from '../agent-router/service.js';
import {
  approveRouterPlan,
  createAgentBinding,
  getRouterPlan,
  getRouterTasks,
  listAgentBindings,
  listRouterEvents,
  listRouterPlans,
  rejectRouterPlan,
  removeAgentBinding,
} from '../agent-router/store.js';
import type Database from 'better-sqlite3';
import type { AppVariables } from '../types.js';

const bindingSchema = z.object({
  agent_profile_id: z.string().trim().min(1).max(200),
  display_name: z.string().trim().max(120).optional(),
  capabilities: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  role_tags: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  priority: z.number().int().min(-100).max(100).optional(),
});

const planSchema = z.object({
  message: z.string().trim().min(1).max(20000),
  session_id: z.string().trim().max(200).nullable().optional(),
});

function publicPlan(plan: ReturnType<typeof getRouterPlan>) {
  if (!plan) return undefined;
  return {
    id: plan.id,
    workspace_jid: plan.workspaceJid,
    session_id: plan.sessionId,
    actor_user_id: plan.actorUserId,
    intent: plan.intent,
    status: plan.status,
    input: plan.input,
    route: plan.route,
    result: plan.result,
    capability_hash: plan.capabilityHash,
    created_at: plan.createdAt,
    updated_at: plan.updatedAt,
    completed_at: plan.completedAt,
    plan_hash: plan.planHash,
    approval_required: plan.approvalRequired,
    approval_status: plan.approvalStatus,
    approval_expires_at: plan.approvalExpiresAt,
    approved_by: plan.approvedBy,
    approved_at: plan.approvedAt,
  };
}

export function createAgentRouterRoutes(db: Database.Database, router: AgentRouterService) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use('*', authMiddleware(db));

  app.get('/:jid/agents', (c) => {
    const agents = listAgentBindings(db, c.get('user')!.id, c.req.param('jid'));
    if (!agents) return c.json({ error: 'Workspace not found' }, 404);
    return c.json({ agents });
  });

  app.post('/:jid/agents', async (c) => {
    const parsed = bindingSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues.map((issue) => issue.message).join('；') }, 400);
    const result = createAgentBinding(db, c.get('user')!.id, c.req.param('jid'), {
      agentProfileId: parsed.data.agent_profile_id,
      displayName: parsed.data.display_name,
      capabilities: parsed.data.capabilities,
      roleTags: parsed.data.role_tags,
      priority: parsed.data.priority,
    });
    if (!result.ok) return c.json({ error: result.reason === 'duplicate' ? 'Agent 已绑定' : result.reason === 'profile_not_found' ? 'Agent profile not found' : 'Workspace not found' }, result.reason === 'duplicate' ? 409 : 404);
    return c.json({ agent: result.binding }, 201);
  });

  app.delete('/:jid/agents/:bindingId', (c) => {
    const ok = removeAgentBinding(db, c.get('user')!.id, c.req.param('jid'), c.req.param('bindingId'));
    return ok ? c.json({ success: true }) : c.json({ error: 'Agent binding not found' }, 404);
  });

  app.post('/:jid/router/plans', async (c) => {
    const user = c.get('user')!;
    if (!canWorkspaceAction(db, user.id, c.req.param('jid'), 'converse')) return c.json({ error: 'Workspace not found' }, 404);
    const parsed = planSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues.map((issue) => issue.message).join('；') }, 400);
    try {
      const plan = router.plan({ actorUserId: user.id, workspaceJid: c.req.param('jid'), sessionId: parsed.data.session_id, message: parsed.data.message });
      return c.json({ plan: publicPlan(plan) }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
  });

  app.get('/:jid/router/plans', (c) => {
    const plans = listRouterPlans(db, c.get('user')!.id, c.req.param('jid'));
    if (!plans) return c.json({ error: 'Workspace not found' }, 404);
    return c.json({ plans: plans.map(publicPlan) });
  });

  app.get('/:jid/router/plans/:planId', (c) => {
    const user = c.get('user')!;
    const plan = getRouterPlan(db, user.id, c.req.param('jid'), c.req.param('planId'));
    if (!plan) return c.json({ error: 'Router plan not found' }, 404);
    return c.json({ plan: publicPlan(plan), tasks: getRouterTasks(db, user.id, c.req.param('jid'), plan.id) });
  });

  app.get('/:jid/router/plans/:planId/events', (c) => {
    const events = listRouterEvents(db, c.get('user')!.id, c.req.param('jid'), c.req.param('planId'));
    if (!events) return c.json({ error: 'Router plan not found' }, 404);
    return c.json({ events });
  });

  app.post('/:jid/router/plans/:planId/dispatch', async (c) => {
    const user = c.get('user')!;
    if (!canWorkspaceAction(db, user.id, c.req.param('jid'), 'converse')) return c.json({ error: 'Router plan not found' }, 404);
    try {
      const result = await router.dispatch({ actorUserId: user.id, workspaceJid: c.req.param('jid'), planId: c.req.param('planId') });
      return c.json({ result });
    } catch (error) {
      const status = error instanceof RouterDispatchBusyError || error instanceof RouterApprovalRequiredError ? 409 : 404;
      return c.json({ error: error instanceof Error ? error.message : String(error) }, status);
    }
  });

  app.post('/:jid/router/plans/:planId/approve', (c) => {
    const result = approveRouterPlan(db, c.get('user')!.id, c.req.param('jid'), c.req.param('planId'));
    if (result.ok) return c.json({ approval_status: result.status });
    const status = result.reason === 'forbidden' ? 403 : result.reason === 'not_found' ? 404 : 409;
    return c.json({ error: `审批失败：${result.reason}` }, status);
  });

  app.post('/:jid/router/plans/:planId/reject', (c) => {
    const result = rejectRouterPlan(db, c.get('user')!.id, c.req.param('jid'), c.req.param('planId'));
    if (result.ok) return c.json({ approval_status: result.status });
    const status = result.reason === 'forbidden' ? 403 : result.reason === 'not_found' ? 404 : 409;
    return c.json({ error: `审批失败：${result.reason}` }, status);
  });

  return app;
}
