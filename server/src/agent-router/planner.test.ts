import { describe, expect, it } from 'vitest';
import { buildAgentRouterPlan, inferRouteIntent } from './planner.js';

const candidates = [
  { bindingId: 'eng-binding', agentProfileId: 'eng', name: '研发 Agent', capabilities: ['code', 'git'], roleTags: ['engineering'], priority: 5 },
  { bindingId: 'ops-binding', agentProfileId: 'ops', name: '运维 Agent', capabilities: ['deploy', 'monitor'], roleTags: ['operations'], priority: 5 },
];

describe('agent router planner', () => {
  it('识别跨岗位意图并生成有依赖顺序的子任务', () => {
    expect(inferRouteIntent('请修复代码并发布上线')).toEqual({
      intent: 'cross_functional',
      requiredCapabilities: ['code', 'deploy'],
    });
    const plan = buildAgentRouterPlan('请修复代码并发布上线', candidates);
    expect(plan.fallback).toBe('single_agent');
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks.map((task) => task.agentProfileId)).toEqual(['eng', 'ops']);
    expect(plan.tasks[1].dependsOn).toEqual([0]);
    expect(plan.tasks.map((task) => task.risk)).toEqual(['write', 'external']);
    expect(plan.risk).toBe('external');
  });

  it('无匹配岗位时安全回退到通用 Agent', () => {
    const plan = buildAgentRouterPlan('写一份总结', [{ ...candidates[0], capabilities: [] }]);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].requiredCapabilities).toEqual([]);
    expect(plan.risk).toBe('read');
  });

  it('显式要求同时处理时生成无依赖子任务', () => {
    const plan = buildAgentRouterPlan('请同时分析代码问题和监控日志', candidates);
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks.every((task) => task.dependsOn.length === 0)).toBe(true);
    expect(plan.explanation).toContain('并行调度');
  });

  it('缺少任务能力时拒绝路由而不静默降级', () => {
    const plan = buildAgentRouterPlan('请发布上线', [candidates[0]]);
    expect(plan.tasks).toHaveLength(0);
    expect(plan.fallback).toBe('reject');
  });

  it('保留单任务风险，外部操作必须进入审批', () => {
    const plan = buildAgentRouterPlan('请发布上线', candidates);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].risk).toBe('external');
    expect(plan.risk).toBe('external');
  });

  it('混合风险的同时请求保持依赖顺序', () => {
    const plan = buildAgentRouterPlan('请同时修复代码并发布上线', candidates);
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0].dependsOn).toEqual([]);
    expect(plan.tasks[1].dependsOn).toEqual([0]);
  });

  it('包含提交或删除动作的分析请求仍需保留变更风险', () => {
    expect(buildAgentRouterPlan('分析代码并提交 git', candidates).risk).toBe('write');
    expect(buildAgentRouterPlan('查看代码并删除文件', candidates).risk).toBe('write');
  });
});
