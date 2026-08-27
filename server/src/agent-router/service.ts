import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AgentRouterResult, AgentRouterTaskResult } from '@deep-worker/shared';
import { getAgentProfileById } from '../agent-profiles.js';
import { createAccessibleRuntimeSession } from '../runtime-sessions.js';
import { RuntimeRunnerService } from '../runtime-runner-service.js';
import { resolveCapabilitiesForWorkspace } from '../capabilities/capability-resolver.js';
import { getWorkspaceById } from '../workspaces.js';
import { buildAgentRouterPlan } from './planner.js';
import {
  appendRouterEvent,
  claimRouterPlan,
  claimRouterTask,
  createRouterPlan,
  getRouterPlan,
  listAgentBindings,
  listRouterTaskRows,
  setRouterPlanStatus,
  setRouterTaskStatus,
  type AgentBindingRow,
  type AgentRouterPlanRow,
} from './store.js';

export type Db = Database.Database;

export class RouterDispatchBusyError extends Error {
  constructor() {
    super('Router plan is already being dispatched');
    this.name = 'RouterDispatchBusyError';
  }
}

export class AgentRouterService {
  constructor(
    private readonly db: Db,
    private readonly runtime: RuntimeRunnerService,
  ) {}

  plan(input: { actorUserId: string; workspaceJid: string; sessionId?: string | null; message: string }): AgentRouterPlanRow {
    const candidates = this.candidates(input.actorUserId, input.workspaceJid);
    const route = buildAgentRouterPlan(input.message, candidates);
    let capabilityHash: string | null = null;
    try {
      capabilityHash = resolveCapabilitiesForWorkspace(this.db, input.actorUserId, input.workspaceJid).hash;
    } catch {
      // The planner still records a rejectable plan; dispatch will surface the exact reason.
    }
    return createRouterPlan(this.db, input.actorUserId, input.workspaceJid, input.sessionId ?? null, input.message, route, capabilityHash);
  }

  async dispatch(input: { actorUserId: string; workspaceJid: string; planId: string }): Promise<AgentRouterResult> {
    const plan = getRouterPlan(this.db, input.actorUserId, input.workspaceJid, input.planId);
    const tasks = listRouterTaskRows(this.db, input.actorUserId, input.workspaceJid, input.planId);
    if (!plan || !tasks) throw new Error('Router plan not found');
    if (plan.status === 'completed') return plan.result ?? this.resultFromTasks(input, plan, []);
    const workerId = `router-worker:${crypto.randomUUID()}`;
    if (!claimRouterPlan(this.db, plan.id, workerId)) {
      const current = getRouterPlan(this.db, input.actorUserId, input.workspaceJid, input.planId);
      if (current?.status === 'completed') return current.result ?? this.resultFromTasks(input, current, []);
      throw new RouterDispatchBusyError();
    }
    appendRouterEvent(this.db, plan.id, null, { type: 'plan_started', planId: plan.id });
    const results: AgentRouterTaskResult[] = [];
    let failed = false;
    for (const task of tasks) {
      if (failed || task.spec.dependsOn.some((ordinal) => results.find((result) => result.ordinal === ordinal)?.status !== 'completed')) {
        setRouterTaskStatus(this.db, task.id, 'skipped', { error: '依赖任务未完成' });
        results.push({ taskId: task.id, ordinal: task.spec.ordinal, agentProfileId: task.spec.agentProfileId, status: 'skipped', text: null, error: '依赖任务未完成' });
        continue;
      }
      if (!claimRouterTask(this.db, task.id, workerId)) {
        const current = listRouterTaskRows(this.db, input.actorUserId, input.workspaceJid, input.planId)?.find((item) => item.id === task.id);
        if (current?.status === 'completed') {
          results.push({ taskId: task.id, ordinal: task.spec.ordinal, agentProfileId: task.spec.agentProfileId, status: 'completed', text: current.resultText });
          continue;
        }
        throw new RouterDispatchBusyError();
      }
      appendRouterEvent(this.db, plan.id, task.id, { type: 'task_started', ordinal: task.spec.ordinal, agentProfileId: task.spec.agentProfileId });
      try {
        const session = createAccessibleRuntimeSession(this.db, input.actorUserId, input.workspaceJid, {
          name: `Router ${plan.id.slice(-8)} · ${task.spec.title}`,
          agent_profile_id: task.spec.agentProfileId,
        });
        if (!session.ok || !session.id) throw new Error('无法创建子 Agent 会话');
        const context = results.filter((result) => result.status === 'completed' && result.text).map((result) => `任务 ${result.ordinal}: ${result.text}`).join('\n');
        const run = await this.runtime.submit({
          ownerUserId: input.actorUserId,
          workspaceJid: input.workspaceJid,
          sessionId: session.id,
          message: context ? `${task.spec.input}\n\n前置任务结果：\n${context}` : task.spec.input,
          idempotencyKey: `router:${plan.id}:${task.id}`,
        });
        if (!setRouterTaskStatus(this.db, task.id, 'completed', { text: run.reply ?? '' }, workerId)) throw new RouterDispatchBusyError();
        appendRouterEvent(this.db, plan.id, task.id, { type: 'task_completed', ordinal: task.spec.ordinal, text: run.reply ?? '' });
        results.push({ taskId: task.id, ordinal: task.spec.ordinal, agentProfileId: task.spec.agentProfileId, status: 'completed', text: run.reply ?? '' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setRouterTaskStatus(this.db, task.id, 'failed', { error: message }, workerId);
        appendRouterEvent(this.db, plan.id, task.id, { type: 'task_failed', ordinal: task.spec.ordinal, error: message });
        results.push({ taskId: task.id, ordinal: task.spec.ordinal, agentProfileId: task.spec.agentProfileId, status: 'failed', text: null, error: message });
        failed = true;
      }
    }
    const result = this.resultFromTasks(input, plan, results);
    setRouterPlanStatus(this.db, plan.id, failed ? 'failed' : 'completed', result, workerId);
    appendRouterEvent(this.db, plan.id, null, { type: failed ? 'plan_failed' : 'plan_completed', planId: plan.id });
    return result;
  }

  private candidates(actorUserId: string, workspaceJid: string): AgentBindingRow[] {
    const bindings = listAgentBindings(this.db, actorUserId, workspaceJid) ?? [];
    if (bindings.length > 0) return bindings;
    const workspace = getWorkspaceById(this.db, workspaceJid);
    if (!workspace?.agent_profile_id) return [];
    const profile = getAgentProfileById(this.db, workspace.agent_profile_id);
    if (!profile) return [];
    return [{
      bindingId: null,
      agentProfileId: profile.id,
      name: profile.name,
      capabilities: ['*'],
      roleTags: ['general'],
      priority: 0,
      workspaceJid,
      enabled: true,
      createdBy: profile.owner_user_id,
      createdAt: profile.created_at,
      updatedAt: profile.updated_at,
    }];
  }

  private resultFromTasks(input: { planId: string }, plan: AgentRouterPlanRow, tasks: AgentRouterTaskResult[]): AgentRouterResult {
    return {
      planId: input.planId,
      status: tasks.some((task) => task.status === 'failed')
        ? 'failed'
        : tasks.length > 0 && tasks.every((task) => task.status === 'completed')
          ? 'completed'
          : plan.status === 'planned'
            ? 'planned'
            : 'completed',
      text: tasks.length ? tasks.filter((task) => task.text).map((task) => task.text).join('\n\n') : null,
      tasks,
    };
  }
}
