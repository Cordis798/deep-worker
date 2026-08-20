import { create } from 'zustand';
import { api, getErrorMessage } from '../api/client.js';

export interface AgentProfile {
  id: string;
  name: string;
  identity_prompt: string;
  soul_prompt: string;
  agents_prompt: string;
  tools_prompt: string;
  prompt_mode: 'append' | 'replace';
  version: number;
  is_default: boolean;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface PromptVersion {
  version: number;
  name: string;
  identity_prompt: string;
  soul_prompt: string;
  agents_prompt: string;
  tools_prompt: string;
  prompt_mode: 'append' | 'replace';
  change_source: string;
  created_at: string;
}

interface AgentState {
  profiles: AgentProfile[];
  selectedId: string | null;
  versions: PromptVersion[];
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  select: (id: string) => Promise<void>;
  create: (payload: Partial<AgentProfile> & { name: string }) => Promise<void>;
  update: (id: string, payload: Partial<AgentProfile>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  restore: (id: string, version: number) => Promise<void>;
}

export const useAgentProfiles = create<AgentState>((set, get) => ({
  profiles: [], selectedId: null, versions: [], loading: false, error: null,
  load: async () => {
    set({ loading: true, error: null });
    try {
      const data = await api.get<{ agent_profiles: AgentProfile[] }>('/api/agent-profiles');
      const selectedId = get().selectedId && data.agent_profiles.some((profile) => profile.id === get().selectedId) ? get().selectedId : data.agent_profiles[0]?.id ?? null;
      set({ profiles: data.agent_profiles, selectedId, loading: false });
      if (selectedId) await get().select(selectedId);
    } catch (error) { set({ loading: false, error: getErrorMessage(error, '加载 Agent 失败') }); }
  },
  select: async (id) => {
    set({ selectedId: id });
    try { const data = await api.get<{ versions: PromptVersion[] }>(`/api/agent-profiles/${encodeURIComponent(id)}/prompt-versions`); set({ versions: data.versions }); } catch (error) { set({ error: getErrorMessage(error, '加载 Prompt 版本失败') }); }
  },
  create: async (payload) => { try { const data = await api.post<{ agent_profile: AgentProfile }>('/api/agent-profiles', payload); set((state) => ({ profiles: [data.agent_profile, ...state.profiles], selectedId: data.agent_profile.id })); await get().select(data.agent_profile.id); } catch (error) { set({ error: getErrorMessage(error, '创建 Agent 失败') }); } },
  update: async (id, payload) => { try { const data = await api.patch<{ agent_profile: AgentProfile }>(`/api/agent-profiles/${encodeURIComponent(id)}`, payload); set((state) => ({ profiles: state.profiles.map((profile) => profile.id === id ? data.agent_profile : profile) })); await get().select(id); } catch (error) { set({ error: getErrorMessage(error, '保存 Agent 失败') }); } },
  remove: async (id) => { try { await api.delete(`/api/agent-profiles/${encodeURIComponent(id)}`); set((state) => ({ profiles: state.profiles.filter((profile) => profile.id !== id), selectedId: state.selectedId === id ? null : state.selectedId })); } catch (error) { set({ error: getErrorMessage(error, '删除 Agent 失败') }); } },
  restore: async (id, version) => { try { const data = await api.post<{ agent_profile: AgentProfile }>(`/api/agent-profiles/${encodeURIComponent(id)}/prompt-versions/${version}/restore`); set((state) => ({ profiles: state.profiles.map((profile) => profile.id === id ? data.agent_profile : profile) })); await get().select(id); } catch (error) { set({ error: getErrorMessage(error, '恢复 Prompt 失败') }); } },
}));
