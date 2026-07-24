export type SpaceRole = 'owner' | 'admin' | 'member' | 'guest';

export const SPACE_PERMISSIONS = {
  manage_space: ['owner', 'admin'],
  manage_members: ['owner', 'admin'],
  manage_budgets: ['owner', 'admin'],
  manage_goals: ['owner', 'admin'],
  add_expense: ['owner', 'admin', 'member'],
  edit_own_expense: ['owner', 'admin', 'member'],
  settle: ['owner', 'admin', 'member'],
  read: ['owner', 'admin', 'member', 'guest'],
} as const;

export type SpacePermission = keyof typeof SPACE_PERMISSIONS;

export function can(role: SpaceRole, permission: SpacePermission) {
  return (SPACE_PERMISSIONS[permission] as readonly string[]).includes(role);
}

export function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'space';
}
