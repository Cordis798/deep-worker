import type { AgentRouterCandidate, AgentRouterPlanSpec, AgentRouterTaskRisk, AgentRouterTaskSpec } from '@deep-worker/shared';

const INTENT_RULES: Array<{ intent: string; tokens: string[]; capabilities: string[]; risk: AgentRouterTaskRisk }> = [
  { intent: 'engineering', tokens: ['代码', 'code', 'git', '测试', 'bug', '开发'], capabilities: ['code'], risk: 'write' },
  { intent: 'operations', tokens: ['部署', '发布', '监控', '日志', '告警', '上线', '运维'], capabilities: ['deploy'], risk: 'external' },
  { intent: 'sales', tokens: ['销售', '客户', 'crm', '邮件', '商机', '报价'], capabilities: ['crm'], risk: 'external' },
];

const RISK_ORDER: AgentRouterTaskRisk[] = ['read', 'write', 'external', 'destructive'];

function includesAny(text: string, tokens: string[]): boolean {
  const normalized = text.toLowerCase();
  return tokens.some((token) => normalized.includes(token.toLowerCase()));
}

function candidateSupports(candidate: AgentRouterCandidate, required: string[]): boolean {
  if (required.length === 0) return true;
  const capabilities = new Set(candidate.capabilities.map((item) => item.toLowerCase()));
  return required.every((item) => capabilities.has('*') || capabilities.has(item.toLowerCase()));
}

function choose(candidates: AgentRouterCandidate[], required: string[], role: string): AgentRouterCandidate | undefined {
  return [...candidates]
    .filter((candidate) => candidateSupports(candidate, required) && (candidate.roleTags.length === 0 || candidate.roleTags.some((tag) => tag.toLowerCase() === role)))
    .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))[0]
    ?? [...candidates].filter((candidate) => candidateSupports(candidate, required)).sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))[0];
}

export function inferRouteIntent(message: string): { intent: string; requiredCapabilities: string[] } {
  const matches = INTENT_RULES.filter((rule) => includesAny(message, rule.tokens));
  if (matches.length === 0) return { intent: 'general', requiredCapabilities: [] };
  if (matches.length === 1) return { intent: matches[0].intent, requiredCapabilities: matches[0].capabilities };
  return { intent: 'cross_functional', requiredCapabilities: [...new Set(matches.flatMap((item) => item.capabilities))] };
}

export function buildAgentRouterPlan(
  message: string,
  candidates: AgentRouterCandidate[],
): AgentRouterPlanSpec {
  const inferred = inferRouteIntent(message);
  const tasks: AgentRouterTaskSpec[] = [];
  const matchedRules = INTENT_RULES.filter((rule) => includesAny(message, rule.tokens));
  const distinctMatches = new Set(matchedRules.map((rule) => choose(candidates, rule.capabilities, rule.intent)?.bindingId).filter(Boolean));
  const taskRules = matchedRules.length > 1 && distinctMatches.size > 1
    ? matchedRules
    : [{ intent: inferred.intent, capabilities: inferred.requiredCapabilities, tokens: [], risk: 'read' }];
  for (const [ordinal, rule] of taskRules.entries()) {
    const candidate = choose(candidates, rule.capabilities, rule.intent);
    if (!candidate) continue;
    tasks.push({
      ordinal,
      bindingId: candidate.bindingId,
      agentProfileId: candidate.agentProfileId,
      title: `${candidate.name}：${rule.intent}`,
      requiredCapabilities: rule.capabilities,
      input: message,
      dependsOn: ordinal === 0 ? [] : [ordinal - 1],
      risk: rule.risk,
    });
  }
  if (tasks.length === 0 && candidates.length > 0) {
    const fallback = choose(candidates, [], 'general') ?? candidates[0];
    tasks.push({ ordinal: 0, bindingId: fallback.bindingId, agentProfileId: fallback.agentProfileId, title: `${fallback.name}：通用处理`, requiredCapabilities: [], input: message, dependsOn: [], risk: 'read' });
  }
  const risk = tasks.reduce<AgentRouterTaskRisk>(
    (current, task) => RISK_ORDER.indexOf(task.risk) > RISK_ORDER.indexOf(current) ? task.risk : current,
    'read',
  );
  return {
    intent: inferred.intent,
    requiredCapabilities: inferred.requiredCapabilities,
    tasks,
    fallback: tasks.length > 0 ? 'single_agent' : 'reject',
    explanation: tasks.length > 1
      ? `识别为跨岗位任务，按依赖顺序调度 ${tasks.length} 个 Agent`
      : tasks.length === 1
        ? '未形成跨岗位依赖，回退为单 Agent 执行'
        : '没有满足能力与权限要求的 Agent',
    risk,
  };
}
