import { describe, expect, it } from 'vitest';
import { beginHostPrivilegeRevocation, canExecuteOnHost, endHostPrivilegeRevocation } from './host-execution-policy.js';

describe('Host 执行实时授权', () => {
  it('只允许 active admin', () => {
    expect(canExecuteOnHost({ role: 'admin', status: 'active' })).toBe(true);
    expect(canExecuteOnHost({ role: 'member', status: 'active' })).toBe(false);
    expect(canExecuteOnHost({ role: 'admin', status: 'disabled' })).toBe(false);
    expect(canExecuteOnHost(undefined)).toBe(false);
  });

  it('权限撤销期间 fail closed', () => {
    const owner = { id: 'admin-1', role: 'admin' as const, status: 'active' as const };
    beginHostPrivilegeRevocation(owner.id);
    expect(canExecuteOnHost(owner)).toBe(false);
    endHostPrivilegeRevocation(owner.id);
    expect(canExecuteOnHost(owner)).toBe(true);
  });
});
