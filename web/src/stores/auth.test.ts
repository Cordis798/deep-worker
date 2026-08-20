import { describe, expect, it } from 'vitest';
import { useAuthStore } from './auth.js';

describe('认证状态', () => {
  it('管理员拥有所有管理权限，成员只拥有显式权限', () => {
    useAuthStore.setState({
      user: {
        id: 'u1', username: 'member', display_name: '成员', role: 'member', status: 'active',
        permissions: ['manage_users'], must_change_password: false,
      },
    });
    expect(useAuthStore.getState().hasPermission('manage_users')).toBe(true);
    expect(useAuthStore.getState().hasPermission('manage_system_config')).toBe(false);
    useAuthStore.setState({ user: { ...useAuthStore.getState().user!, role: 'admin' } });
    expect(useAuthStore.getState().hasPermission('manage_system_config')).toBe(true);
  });
});
