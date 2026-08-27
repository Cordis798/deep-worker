export type AgentRouterPlanStatus =
  | 'planned'
  | 'awaiting_approval'
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'uncertain'
  | 'validation_failed';
export type AgentRouterTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped';
export type AgentRouterTaskRisk = 'read' | 'write' | 'external' | 'destructive';
export type AgentRouterApprovalStatus = 'not_required' | 'pending' | 'approved' | 'rejected' | 'expired';

export interface AgentRouterCandidate {
  bindingId: string | null;
  agentProfileId: string;
  name: string;
  capabilities: string[];
  roleTags: string[];
  priority: number;
  identityHash?: string;
}

export interface AgentRouterTaskSpec {
  ordinal: number;
  bindingId: string | null;
  agentProfileId: string;
  title: string;
  requiredCapabilities: string[];
  input: string;
  dependsOn: number[];
  risk: AgentRouterTaskRisk;
  /** 计划创建时绑定的 AgentProfile 内容指纹。 */
  agentProfileHash?: string;
}

export interface AgentRouterPlanSpec {
  intent: string;
  requiredCapabilities: string[];
  tasks: AgentRouterTaskSpec[];
  fallback: 'single_agent' | 'reject';
  explanation: string;
  risk: AgentRouterTaskRisk;
}

export interface AgentRouterTaskResult {
  taskId: string;
  ordinal: number;
  agentProfileId: string;
  status: AgentRouterTaskStatus;
  text: string | null;
  error?: string;
}

export interface AgentRouterResult {
  planId: string;
  status: AgentRouterPlanStatus;
  text: string | null;
  tasks: AgentRouterTaskResult[];
}
