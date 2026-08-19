import {
  ALL_PERMISSIONS,
  type Permission,
  type UserRole,
} from './types.js';

export const ROLE_DEFAULT_PERMISSIONS: Record<UserRole, Permission[]> = {
  admin: [...ALL_PERMISSIONS],
  member: [],
};

export function normalizePermissions(input: unknown): Permission[] {
  if (!Array.isArray(input)) return [];
  const allowed = ALL_PERMISSIONS as readonly string[];
  return Array.from(
    new Set(
      input.filter(
        (value): value is Permission =>
          typeof value === 'string' && allowed.includes(value),
      ),
    ),
  );
}

export function getDefaultPermissions(role: UserRole): Permission[] {
  return [...(ROLE_DEFAULT_PERMISSIONS[role] || [])];
}

export function hasPermission(
  user: { role: UserRole; permissions: Permission[] },
  permission: Permission,
): boolean {
  if (user.role === 'admin') return true;
  return user.permissions.includes(permission);
}
