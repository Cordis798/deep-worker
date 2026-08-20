import { create } from 'zustand';
import { api } from '../api/client.js';

export interface Workspace {
  jid: string;
  folder: string;
  name: string;
  agent_profile_id: string | null;
  status: string;
  is_home: boolean;
  created_at: string;
  updated_at: string;
}

export interface RuntimeSession {
  id: string;
  workspace_jid: string;
  name: string;
  agent_profile_id: string | null;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface ChannelMount {
  im_jid: string;
  channel_type: string;
  channel_account_id: string | null;
}

interface WorkspaceState {
  workspaces: Workspace[];
  sessions: Record<string, RuntimeSession[]>;
  mounts: Record<string, ChannelMount[]>;
  currentWorkspaceId: string | null;
  currentSessionId: string | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  loadSessions: (workspaceId: string) => Promise<void>;
  loadMounts: (workspaceId: string) => Promise<void>;
  selectWorkspace: (workspaceId: string) => Promise<void>;
  selectSession: (sessionId: string) => void;
  createWorkspace: (name: string, agentProfileId?: string | null) => Promise<Workspace>;
  createSession: (workspaceId: string, name: string, agentProfileId?: string | null) => Promise<RuntimeSession>;
}

function saved(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 本地存储不可用时仍保持内存内的导航状态。
  }
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  sessions: {},
  mounts: {},
  currentWorkspaceId: saved('deep-worker.workspace') ,
  currentSessionId: saved('deep-worker.session'),
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const data = await api.get<{ workspaces: Workspace[] }>('/api/workspaces');
      const preferred = get().currentWorkspaceId;
      const workspace = data.workspaces.find((item) => item.jid === preferred) ?? data.workspaces[0] ?? null;
      set({
        workspaces: data.workspaces,
        currentWorkspaceId: workspace?.jid ?? null,
        currentSessionId: workspace?.jid === preferred ? get().currentSessionId : null,
        loading: false,
      });
      if (workspace) {
        await Promise.all([get().loadSessions(workspace.jid), get().loadMounts(workspace.jid)]);
      }
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '加载工作区失败' });
    }
  },

  loadSessions: async (workspaceId) => {
    const data = await api.get<{ sessions: RuntimeSession[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/runtime-sessions`);
    const preferred = get().currentSessionId;
    const session = data.sessions.find((item) => item.id === preferred) ?? data.sessions.find((item) => item.status === 'active') ?? data.sessions[0] ?? null;
    set((state) => ({
      sessions: { ...state.sessions, [workspaceId]: data.sessions },
      currentSessionId: session?.id ?? null,
    }));
    if (session) save('deep-worker.session', session.id);
  },

  loadMounts: async (workspaceId) => {
    const data = await api.get<{ channel_mounts: ChannelMount[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/channel-mounts`);
    set((state) => ({ mounts: { ...state.mounts, [workspaceId]: data.channel_mounts } }));
  },

  selectWorkspace: async (workspaceId) => {
    set({ currentWorkspaceId: workspaceId, currentSessionId: null });
    save('deep-worker.workspace', workspaceId);
    await Promise.all([get().loadSessions(workspaceId), get().loadMounts(workspaceId)]);
  },

  selectSession: (sessionId) => {
    set({ currentSessionId: sessionId });
    save('deep-worker.session', sessionId);
  },

  createWorkspace: async (name, agentProfileId) => {
    const data = await api.post<{ workspace: Workspace }>('/api/workspaces', {
      name,
      agent_profile_id: agentProfileId ?? null,
    });
    set((state) => ({ workspaces: [...state.workspaces, data.workspace], currentWorkspaceId: data.workspace.jid, currentSessionId: null }));
    save('deep-worker.workspace', data.workspace.jid);
    await get().loadSessions(data.workspace.jid);
    return data.workspace;
  },

  createSession: async (workspaceId, name, agentProfileId) => {
    const data = await api.post<{ session: RuntimeSession }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/runtime-sessions`, {
      name,
      agent_profile_id: agentProfileId ?? null,
    });
    await get().loadSessions(workspaceId);
    get().selectSession(data.session.id);
    return data.session;
  },
}));
