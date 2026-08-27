import { create } from 'zustand';
import { api, getErrorMessage } from '../api/client.js';

export interface AgentBinding {
  bindingId: string;
  agentProfileId: string;
  name: string;
  capabilities: string[];
  roleTags: string[];
  priority: number;
}

export interface RouterTask {
  taskId: string;
  ordinal: number;
  agentProfileId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped';
  text: string | null;
  error?: string;
}

export interface RouterPlan {
  id: string;
  intent: string;
  status: 'planned' | 'running' | 'completed' | 'failed' | 'cancelled';
  input: string;
  route: { tasks: unknown[]; explanation: string };
  result: { text: string | null } | null;
}

interface AgentRouterState {
  agents: Record<string, AgentBinding[]>;
  plans: Record<string, RouterPlan[]>;
  loading: boolean;
  error: string | null;
  load: (workspaceId: string) => Promise<void>;
  createPlan: (workspaceId: string, message: string) => Promise<RouterPlan>;
  dispatch: (workspaceId: string, planId: string) => Promise<void>;
  clearError: () => void;
}

export const useAgentRouterStore = create<AgentRouterState>((set, get) => ({
  agents: {},
  plans: {},
  loading: false,
  error: null,

  load: async (workspaceId) => {
    set({ loading: true, error: null });
    try {
      const [agents, plans] = await Promise.all([
        api.get<{ agents: AgentBinding[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents`),
        api.get<{ plans: RouterPlan[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/router/plans`),
      ]);
      set((state) => ({ agents: { ...state.agents, [workspaceId]: agents.agents }, plans: { ...state.plans, [workspaceId]: plans.plans }, loading: false }));
    } catch (error) {
      set({ loading: false, error: getErrorMessage(error, '加载路由器失败') });
    }
  },

  createPlan: async (workspaceId, message) => {
    set({ error: null });
    try {
      const data = await api.post<{ plan: RouterPlan }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/router/plans`, { message });
      set((state) => ({ plans: { ...state.plans, [workspaceId]: [data.plan, ...(state.plans[workspaceId] ?? [])] } }));
      return data.plan;
    } catch (error) {
      const messageText = getErrorMessage(error, '无法创建路由计划');
      set({ error: messageText });
      throw error;
    }
  },

  dispatch: async (workspaceId, planId) => {
    set({ error: null });
    try {
      const data = await api.post<{ result: { status: RouterPlan['status'] } }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/router/plans/${encodeURIComponent(planId)}/dispatch`);
      set((state) => ({ plans: { ...state.plans, [workspaceId]: (state.plans[workspaceId] ?? []).map((plan) => plan.id === planId ? { ...plan, status: data.result.status } : plan) } }));
    } catch (error) {
      set({ error: getErrorMessage(error, '路由调度失败') });
      throw error;
    }
  },

  clearError: () => set({ error: null }),
}));
