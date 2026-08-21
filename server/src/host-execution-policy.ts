import type { UserRole, UserStatus } from './types.js';

const revokingHostPrivilegeUserIds = new Set<string>();

export interface HostOwner {
  id?: string;
  role: UserRole;
  status: UserStatus;
}

export function beginHostPrivilegeRevocation(userId: string): void {
  revokingHostPrivilegeUserIds.add(userId);
}

export function endHostPrivilegeRevocation(userId: string): void {
  revokingHostPrivilegeUserIds.delete(userId);
}

export function canExecuteOnHost(owner: HostOwner | null | undefined): boolean {
  return Boolean(
    owner?.role === 'admin' &&
      owner.status === 'active' &&
      (!owner.id || !revokingHostPrivilegeUserIds.has(owner.id)),
  );
}

export const HOST_EXECUTION_FORBIDDEN_ERROR = 'Host 执行只允许当前处于 active 状态的管理员';
