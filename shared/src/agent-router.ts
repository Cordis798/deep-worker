export type AgentRouterPlanStatus = 'planned' | 'running' | 'completed' | 'failed' | 'cancelled';
export type AgentRouterTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped';

export interface AgentRouterCandidate {
  bindingId: string;
  agentProfileId: string;
  name: string;
  capabilities: string[];
  roleTags: string[];
  priority: number;
}

export interface AgentRouterTaskSpec {
  ordinal: number;
  bindingId: string | null;
  agentProfileId: string;
  title: string;
  requiredCapabilities: string[];
  input: string;
  dependsOn: number[];
}

export interface AgentRouterPlanSpec {
  intent: string;
  requiredCapabilities: string[];
  tasks: AgentRouterTaskSpec[];
  fallback: 'single_agent' | 'reject';
  explanation: string;
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
