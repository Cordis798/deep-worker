import { create } from 'zustand';
import { api, getErrorMessage } from '../api/client.js';
import { openTerminalStream } from '../api/terminal.js';

export interface TerminalSession { id: string; status: 'running' | 'exited' | 'failed'; degraded?: boolean; notice?: string; }
interface TerminalState { sessions: TerminalSession[]; activeId: string | null; output: Record<string, string>; loading: boolean; error: string | null; load: (workspaceId: string) => Promise<void>; create: (workspaceId: string) => Promise<void>; connect: (workspaceId: string, sessionId: string) => void; write: (sessionId: string, data: string) => void; close: (workspaceId: string, sessionId: string) => Promise<void>; }

export const useTerminalStore = create<TerminalState>((set, get) => {
  const streams = new Map<string, { send: (data: string) => boolean; close: () => void }>();
  return {
    sessions: [], activeId: null, output: {}, loading: false, error: null,
    load: async (workspaceId) => { set({ loading: true, error: null }); try { const data = await api.get<{ sessions: TerminalSession[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/terminal-sessions`); set({ sessions: data.sessions, activeId: data.sessions.find((session) => session.status === 'running')?.id ?? data.sessions[0]?.id ?? null, loading: false }); } catch (error) { set({ loading: false, error: getErrorMessage(error, '加载终端会话失败') }); } },
    create: async (workspaceId) => { try { const data = await api.post<{ session: TerminalSession }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/terminal-sessions`, {}); set((state) => ({ sessions: [...state.sessions, data.session], activeId: data.session.id, output: { ...state.output, [data.session.id]: '' } })); get().connect(workspaceId, data.session.id); } catch (error) { set({ error: getErrorMessage(error, '创建终端会话失败') }); } },
    connect: (workspaceId, sessionId) => { streams.get(sessionId)?.close(); const stream = openTerminalStream(workspaceId, sessionId, { onOutput: (data) => set((state) => ({ output: { ...state.output, [sessionId]: `${state.output[sessionId] ?? ''}${data}` } })), onStatus: (status) => set((state) => ({ sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, status: status as TerminalSession['status'] } : session) })), onClose: () => streams.delete(sessionId) }); streams.set(sessionId, stream); set({ activeId: sessionId }); },
    write: (sessionId, data) => { streams.get(sessionId)?.send(data); },
    close: async (workspaceId, sessionId) => { streams.get(sessionId)?.close(); streams.delete(sessionId); await api.delete(`/api/workspaces/${encodeURIComponent(workspaceId)}/terminal-sessions/${encodeURIComponent(sessionId)}`); set((state) => ({ sessions: state.sessions.filter((session) => session.id !== sessionId), activeId: state.activeId === sessionId ? null : state.activeId })); },
  };
});
