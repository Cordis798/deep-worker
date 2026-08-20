import { describe, expect, it } from 'vitest';
import { useWorkspaceStore } from './workspaces.js';

describe('Workspace 导航状态', () => {
  it('切换会话时只更新当前会话并保留工作区', () => {
    useWorkspaceStore.setState({ currentWorkspaceId: 'web:one', currentSessionId: null });
    useWorkspaceStore.getState().selectSession('rs_one');
    expect(useWorkspaceStore.getState().currentWorkspaceId).toBe('web:one');
    expect(useWorkspaceStore.getState().currentSessionId).toBe('rs_one');
  });
});
