import { create } from 'zustand';
import { api, apiFetch, getErrorMessage } from '../api/client.js';

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
  isSystem: boolean;
}

interface FileState {
  files: FileEntry[];
  currentPath: string;
  loading: boolean;
  error: string | null;
  load: (workspaceId: string, path?: string) => Promise<void>;
  upload: (workspaceId: string, files: FileList, path: string) => Promise<void>;
  createDirectory: (workspaceId: string, name: string) => Promise<void>;
  remove: (workspaceId: string, filePath: string) => Promise<void>;
  read: (workspaceId: string, filePath: string) => Promise<string>;
  save: (workspaceId: string, filePath: string, content: string) => Promise<void>;
}

export function encodeFilePath(filePath: string) {
  const bytes = new TextEncoder().encode(filePath);
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export const useFileStore = create<FileState>((set, get) => ({
  files: [],
  currentPath: '',
  loading: false,
  error: null,

  load: async (workspaceId, requestedPath) => {
    set({ loading: true, error: null });
    try {
      const path = requestedPath ?? get().currentPath;
      const params = path ? `?path=${encodeURIComponent(path)}` : '';
      const data = await api.get<{ files: FileEntry[]; currentPath: string }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/files${params}`);
      set({ files: data.files, currentPath: data.currentPath, loading: false });
    } catch (error) {
      set({ loading: false, error: getErrorMessage(error, '加载文件失败') });
    }
  },

  upload: async (workspaceId, fileList, path) => {
    const form = new FormData();
    for (const file of Array.from(fileList)) form.append('files', file);
    if (path) form.append('path', path);
    try {
      await apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/files`, { method: 'POST', body: form, timeoutMs: 120_000 });
      await get().load(workspaceId, path);
    } catch (error) {
      set({ error: getErrorMessage(error, '上传文件失败') });
    }
  },

  createDirectory: async (workspaceId, name) => {
    try {
      await api.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/directories`, { path: get().currentPath, name });
      await get().load(workspaceId);
    } catch (error) {
      set({ error: getErrorMessage(error, '创建目录失败') });
    }
  },

  remove: async (workspaceId, filePath) => {
    try {
      await api.delete(`/api/workspaces/${encodeURIComponent(workspaceId)}/files/${encodeFilePath(filePath)}`);
      await get().load(workspaceId);
    } catch (error) {
      set({ error: getErrorMessage(error, '删除失败') });
    }
  },

  read: async (workspaceId, filePath) => {
    const data = await api.get<{ content: string }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/files/content/${encodeFilePath(filePath)}`);
    return data.content;
  },

  save: async (workspaceId, filePath, content) => {
    try {
      await api.put(`/api/workspaces/${encodeURIComponent(workspaceId)}/files/content/${encodeFilePath(filePath)}`, { content });
      await get().load(workspaceId);
    } catch (error) {
      set({ error: getErrorMessage(error, '保存文件失败') });
    }
  },
}));
