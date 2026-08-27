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
  status: 'planned' | 'awaiting_approval' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'uncertain' | 'validation_failed';
  input: string;
  route: { tasks: unknown[]; explanation: string; risk?: 'read' | 'write' | 'external' | 'destructive' };
  result: { text: string | null } | null;
  approval_required?: boolean;
  approval_status?: 'not_required' | 'pending' | 'approved' | 'rejected' | 'expired';
  approval_expires_at?: string | null;
}

interface AgentRouterState {
  agents: Record<string, AgentBinding[]>;
  plans: Record<string, RouterPlan[]>;
  loading: boolean;
  error: string | null;
  load: (workspaceId: string) => Promise<void>;
  createPlan: (workspaceId: string, message: string) => Promise<RouterPlan>;
  dispatch: (workspaceId: string, planId: string) => Promise<void>;
  approve: (workspaceId: string, planId: string) => Promise<void>;
  reject: (workspaceId: string, planId: string) => Promise<void>;
  cancel: (workspaceId: string, planId: string) => Promise<void>;
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

  approve: async (workspaceId, planId) => {
    set({ error: null });
    try {
      await api.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/router/plans/${encodeURIComponent(planId)}/approve`);
      set((state) => ({ plans: { ...state.plans, [workspaceId]: (state.plans[workspaceId] ?? []).map((plan) => plan.id === planId ? { ...plan, status: 'planned', approval_status: 'approved' } : plan) } }));
    } catch (error) {
      set({ error: getErrorMessage(error, '审批失败') });
      throw error;
    }
  },

  reject: async (workspaceId, planId) => {
    set({ error: null });
    try {
      await api.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/router/plans/${encodeURIComponent(planId)}/reject`);
      set((state) => ({ plans: { ...state.plans, [workspaceId]: (state.plans[workspaceId] ?? []).map((plan) => plan.id === planId ? { ...plan, status: 'planned', approval_status: 'rejected' } : plan) } }));
    } catch (error) {
      set({ error: getErrorMessage(error, '拒绝审批失败') });
      throw error;
    }
  },

  cancel: async (workspaceId, planId) => {
    set({ error: null });
    try {
      await api.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/router/plans/${encodeURIComponent(planId)}/cancel`);
      set((state) => ({ plans: { ...state.plans, [workspaceId]: (state.plans[workspaceId] ?? []).map((plan) => plan.id === planId ? { ...plan, status: 'cancelled' } : plan) } }));
    } catch (error) {
      set({ error: getErrorMessage(error, '取消编排失败') });
      throw error;
    }
  },

  clearError: () => set({ error: null }),
}));
