-- Up Migration
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_users_is_admin
  ON users(is_admin)
  WHERE is_admin = TRUE AND deleted_at IS NULL;

INSERT INTO permissions (module, code, name, description, is_default)
VALUES
  ('dashboard', 'dashboard.access', 'Dashboard', 'Access the dashboard overview', TRUE),
  ('accounts', 'accounts.access', 'Accounts', 'Manage financial containers and balances', TRUE),
  ('expenses', 'expenses.access', 'Transactions', 'View and manage ledger transactions', TRUE),
  ('recurring', 'recurring.access', 'Recurring', 'Manage recurring schedules and subscriptions', TRUE),
  ('investments', 'investments.access', 'Investments', 'Manage investment holdings', TRUE),
  ('loans', 'loans.access', 'Loans', 'Manage loans and debt plans', TRUE),
  ('budgets', 'budgets.access', 'Budgets', 'Manage budgets and envelopes', TRUE),
  ('goals', 'goals.access', 'Goals', 'Manage savings goals', TRUE),
  ('categories', 'categories.access', 'Categories', 'Manage spend categories', TRUE),
  ('reports', 'reports.access', 'Reports', 'View financial reports', TRUE),
  ('spaces', 'spaces.access', 'Spaces', 'Access collaborative spaces', TRUE),
  ('ai', 'ai.access', 'AI Advisor', 'Use the AI advisor workspace', TRUE),
  ('settings', 'settings.access', 'Settings', 'Manage profile and app settings', TRUE),
  ('sync', 'sync.access', 'Offline Sync', 'Push and pull offline sync data', TRUE),
  ('admin', 'admin.access', 'Admin Console', 'Open the platform admin console', FALSE),
  ('admin', 'admin.manage_users', 'Manage Users', 'List users and view their access', FALSE),
  ('admin', 'admin.manage_permissions', 'Manage Permissions', 'Grant or revoke user permissions', FALSE)
ON CONFLICT (code) DO NOTHING;

-- Down Migration
DROP INDEX IF EXISTS idx_users_is_admin;
ALTER TABLE users DROP COLUMN IF EXISTS is_admin;
DELETE FROM permissions
WHERE code IN (
  'dashboard.access',
  'accounts.access',
  'expenses.access',
  'recurring.access',
  'investments.access',
  'loans.access',
  'budgets.access',
  'goals.access',
  'categories.access',
  'reports.access',
  'spaces.access',
  'ai.access',
  'settings.access',
  'sync.access',
  'admin.access',
  'admin.manage_users',
  'admin.manage_permissions'
);
