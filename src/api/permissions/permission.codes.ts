export const CRUD_ACTIONS = ['create', 'read', 'update', 'delete'] as const;
export type CrudAction = (typeof CRUD_ACTIONS)[number];

/** Modules that support full CRUD (+ .access for module entry). */
export const CRUD_MODULES = [
  'accounts',
  'expenses',
  'recurring',
  'investments',
  'loans',
  'budgets',
  'goals',
  'categories',
  'spaces',
] as const;

export type CrudModule = (typeof CRUD_MODULES)[number];

export function perm(module: string, action: string): string {
  return `${module}.${action}`;
}

export function crudPerm(module: CrudModule | string, action: CrudAction): string {
  return perm(module, action);
}

export const PERMISSION_CODES = {
  DASHBOARD_ACCESS: 'dashboard.access',
  DASHBOARD_READ: 'dashboard.read',

  ACCOUNTS_ACCESS: 'accounts.access',
  ACCOUNTS_CREATE: 'accounts.create',
  ACCOUNTS_READ: 'accounts.read',
  ACCOUNTS_UPDATE: 'accounts.update',
  ACCOUNTS_DELETE: 'accounts.delete',

  EXPENSES_ACCESS: 'expenses.access',
  EXPENSES_CREATE: 'expenses.create',
  EXPENSES_READ: 'expenses.read',
  EXPENSES_UPDATE: 'expenses.update',
  EXPENSES_DELETE: 'expenses.delete',

  RECURRING_ACCESS: 'recurring.access',
  RECURRING_CREATE: 'recurring.create',
  RECURRING_READ: 'recurring.read',
  RECURRING_UPDATE: 'recurring.update',
  RECURRING_DELETE: 'recurring.delete',

  INVESTMENTS_ACCESS: 'investments.access',
  INVESTMENTS_CREATE: 'investments.create',
  INVESTMENTS_READ: 'investments.read',
  INVESTMENTS_UPDATE: 'investments.update',
  INVESTMENTS_DELETE: 'investments.delete',

  LOANS_ACCESS: 'loans.access',
  LOANS_CREATE: 'loans.create',
  LOANS_READ: 'loans.read',
  LOANS_UPDATE: 'loans.update',
  LOANS_DELETE: 'loans.delete',

  BUDGETS_ACCESS: 'budgets.access',
  BUDGETS_CREATE: 'budgets.create',
  BUDGETS_READ: 'budgets.read',
  BUDGETS_UPDATE: 'budgets.update',
  BUDGETS_DELETE: 'budgets.delete',

  GOALS_ACCESS: 'goals.access',
  GOALS_CREATE: 'goals.create',
  GOALS_READ: 'goals.read',
  GOALS_UPDATE: 'goals.update',
  GOALS_DELETE: 'goals.delete',

  CATEGORIES_ACCESS: 'categories.access',
  CATEGORIES_CREATE: 'categories.create',
  CATEGORIES_READ: 'categories.read',
  CATEGORIES_UPDATE: 'categories.update',
  CATEGORIES_DELETE: 'categories.delete',

  REPORTS_ACCESS: 'reports.access',
  REPORTS_READ: 'reports.read',

  SPACES_ACCESS: 'spaces.access',
  SPACES_CREATE: 'spaces.create',
  SPACES_READ: 'spaces.read',
  SPACES_UPDATE: 'spaces.update',
  SPACES_DELETE: 'spaces.delete',

  AI_ACCESS: 'ai.access',
  AI_CREATE: 'ai.create',
  AI_READ: 'ai.read',
  AI_UPDATE: 'ai.update',
  AI_DELETE: 'ai.delete',

  SETTINGS_ACCESS: 'settings.access',
  SETTINGS_READ: 'settings.read',
  SETTINGS_UPDATE: 'settings.update',

  SYNC_ACCESS: 'sync.access',
  SYNC_CREATE: 'sync.create',
  SYNC_READ: 'sync.read',

  ADMIN_ACCESS: 'admin.access',
  ADMIN_MANAGE_USERS: 'admin.manage_users',
  ADMIN_MANAGE_PERMISSIONS: 'admin.manage_permissions',
} as const;

export type PermissionCode =
  (typeof PERMISSION_CODES)[keyof typeof PERMISSION_CODES];

/** Seed metadata used by migrations / catalog docs. */
export type PermissionSeed = {
  module: string;
  code: string;
  name: string;
  description: string;
  is_default: boolean;
};

export function buildCrudSeeds(
  module: string,
  label: string,
  isDefault = true,
): PermissionSeed[] {
  return [
    {
      module,
      code: perm(module, 'access'),
      name: `${label} module`,
      description: `Open the ${label} module`,
      is_default: isDefault,
    },
    {
      module,
      code: perm(module, 'create'),
      name: `Create ${label}`,
      description: `Create ${label.toLowerCase()} records`,
      is_default: isDefault,
    },
    {
      module,
      code: perm(module, 'read'),
      name: `Read ${label}`,
      description: `View ${label.toLowerCase()} records`,
      is_default: isDefault,
    },
    {
      module,
      code: perm(module, 'update'),
      name: `Update ${label}`,
      description: `Edit ${label.toLowerCase()} records`,
      is_default: isDefault,
    },
    {
      module,
      code: perm(module, 'delete'),
      name: `Delete ${label}`,
      description: `Delete ${label.toLowerCase()} records`,
      is_default: isDefault,
    },
  ];
}

/** Sync entity → module used for CRUD permission checks */
export const SYNC_ENTITY_MODULE: Record<string, string> = {
  account: 'accounts',
  transaction: 'expenses',
  category: 'categories',
  budget: 'budgets',
  goal: 'goals',
  investment: 'investments',
  loan: 'loans',
  recurring: 'recurring',
  user_settings: 'settings',
  ai_preferences: 'ai',
  ai_memory: 'ai',
  notification_preferences: 'settings',
};

/** @deprecated prefer SYNC_ENTITY_MODULE + crud action */
export const SYNC_ENTITY_PERMISSION: Record<string, PermissionCode> = {
  account: PERMISSION_CODES.ACCOUNTS_READ,
  transaction: PERMISSION_CODES.EXPENSES_READ,
  category: PERMISSION_CODES.CATEGORIES_READ,
  budget: PERMISSION_CODES.BUDGETS_READ,
  goal: PERMISSION_CODES.GOALS_READ,
  investment: PERMISSION_CODES.INVESTMENTS_READ,
  loan: PERMISSION_CODES.LOANS_READ,
  recurring: PERMISSION_CODES.RECURRING_READ,
  user_settings: PERMISSION_CODES.SETTINGS_READ,
  ai_preferences: PERMISSION_CODES.AI_READ,
  ai_memory: PERMISSION_CODES.AI_READ,
  notification_preferences: PERMISSION_CODES.SETTINGS_READ,
};

export function syncOpToCrud(op: string): CrudAction {
  if (op === 'create') return 'create';
  if (op === 'delete') return 'delete';
  if (op === 'update' || op === 'upsert') return 'update';
  return 'read';
}

/**
 * Flexible check:
 * - Exact code match
 * - Asking for module.access also succeeds if the user holds any CRUD
 *   on that module (so read-only users can still open the module)
 */
export function permissionSatisfied(
  granted: string[] | Set<string>,
  required: string,
): boolean {
  const set = granted instanceof Set ? granted : new Set(granted);
  if (set.has(required)) return true;

  const [module, action] = required.split('.');
  if (!module || !action) return false;

  if (action === 'access') {
    return CRUD_ACTIONS.some((a) => set.has(perm(module, a)));
  }

  // Holding module.access means the user can use that module fully.
  if (
    (CRUD_ACTIONS as readonly string[]).includes(action) &&
    set.has(perm(module, 'access'))
  ) {
    return true;
  }

  return false;
}

export function parseAdminEmails(raw?: string): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}
