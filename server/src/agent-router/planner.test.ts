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
  });

  it('无匹配岗位时安全回退到通用 Agent', () => {
    const plan = buildAgentRouterPlan('写一份总结', [{ ...candidates[0], capabilities: [] }]);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].requiredCapabilities).toEqual([]);
  });
});
