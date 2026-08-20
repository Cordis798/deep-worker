import { create } from 'zustand';
import { api, type ApiError } from '../api/client.js';

export type Permission =
  | 'manage_system_config'
  | 'manage_group_env'
  | 'manage_users'
  | 'manage_invites'
  | 'view_audit_log'
  | 'manage_billing';

export interface UserPublic {
  id: string;
  username: string;
  display_name: string;
  role: 'admin' | 'member';
  status: 'active' | 'disabled' | 'deleted';
  permissions: Permission[];
  must_change_password: boolean;
}

interface AuthState {
  user: UserPublic | null;
  authenticated: boolean;
  initialized: boolean | null;
  checking: boolean;
  error: string | null;
  checkAuth: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (payload: {
    username: string;
    password: string;
    display_name?: string;
    invite_code?: string;
  }) => Promise<void>;
  setup: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  hasPermission: (permission: Permission) => boolean;
  clearError: () => void;
}

let authRequest: Promise<void> | null = null;

function isApiError(error: unknown): error is ApiError {
  return !!error && typeof error === 'object' && 'status' in error;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  authenticated: false,
  initialized: null,
  checking: true,
  error: null,

  checkAuth: async () => {
    if (authRequest) return authRequest;
    authRequest = (async () => {
      set({ checking: true, error: null });
      try {
        const response = await api.get<{ user: UserPublic }>('/api/auth/me');
        set({ user: response.user, authenticated: true, initialized: true });
      } catch (error) {
        if (!isApiError(error) || error.status !== 401) {
          set({ error: isApiError(error) ? error.message : '无法连接服务器' });
        }
        try {
          const status = await api.get<{ initialized: boolean }>('/api/auth/status');
          set({ initialized: status.initialized });
        } catch {
          set({ initialized: true });
        }
        set({ user: null, authenticated: false });
      } finally {
        set({ checking: false });
      }
    })().finally(() => {
      authRequest = null;
    });
    return authRequest;
  },

  login: async (username, password) => {
    set({ error: null });
    const response = await api.post<{ user: UserPublic }>('/api/auth/login', {
      username,
      password,
    });
    set({ user: response.user, authenticated: true, initialized: true });
  },

  register: async (payload) => {
    set({ error: null });
    const response = await api.post<{ user: UserPublic }>('/api/auth/register', payload);
    set({ user: response.user, authenticated: true, initialized: true });
  },

  setup: async (username, password) => {
    set({ error: null });
    const response = await api.post<{ user: UserPublic }>('/api/auth/setup', {
      username,
      password,
    });
    set({ user: response.user, authenticated: true, initialized: true });
  },

  logout: async () => {
    await api.post('/api/auth/logout');
    set({ user: null, authenticated: false, initialized: true });
  },

  hasPermission: (permission) => {
    const user = get().user;
    return !!user && (user.role === 'admin' || user.permissions.includes(permission));
  },

  clearError: () => set({ error: null }),
}));
