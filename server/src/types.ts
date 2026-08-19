export type UserRole = 'admin' | 'member';
export type UserStatus = 'active' | 'disabled' | 'deleted';

export const ALL_PERMISSIONS = [
  'manage_system_config',
  'manage_group_env',
  'manage_users',
  'manage_invites',
  'view_audit_log',
  'manage_billing',
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  display_name: string;
  permissions: Permission[];
  must_change_password: boolean;
}

export interface AppVariables {
  requestId: string;
  user?: AuthUser;
  sessionId?: string;
}
