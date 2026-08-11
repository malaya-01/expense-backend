-- Up Migration
-- Flexible CRUD permissions per module (alongside existing *.access).

INSERT INTO permissions (module, code, name, description, is_default)
VALUES
  -- dashboard
  ('dashboard', 'dashboard.read', 'Read Dashboard', 'View dashboard data', TRUE),

  -- accounts CRUD
  ('accounts', 'accounts.create', 'Create Accounts', 'Create financial containers', TRUE),
  ('accounts', 'accounts.read', 'Read Accounts', 'View financial containers', TRUE),
  ('accounts', 'accounts.update', 'Update Accounts', 'Edit financial containers', TRUE),
  ('accounts', 'accounts.delete', 'Delete Accounts', 'Delete financial containers', TRUE),

  -- expenses / transactions CRUD
  ('expenses', 'expenses.create', 'Create Transactions', 'Create ledger transactions', TRUE),
  ('expenses', 'expenses.read', 'Read Transactions', 'View ledger transactions', TRUE),
  ('expenses', 'expenses.update', 'Update Transactions', 'Edit ledger transactions', TRUE),
  ('expenses', 'expenses.delete', 'Delete Transactions', 'Delete ledger transactions', TRUE),

  -- recurring CRUD
  ('recurring', 'recurring.create', 'Create Recurring', 'Create recurring schedules', TRUE),
  ('recurring', 'recurring.read', 'Read Recurring', 'View recurring schedules', TRUE),
  ('recurring', 'recurring.update', 'Update Recurring', 'Edit recurring schedules', TRUE),
  ('recurring', 'recurring.delete', 'Delete Recurring', 'Delete recurring schedules', TRUE),

  -- investments CRUD
  ('investments', 'investments.create', 'Create Investments', 'Create investment holdings', TRUE),
  ('investments', 'investments.read', 'Read Investments', 'View investment holdings', TRUE),
  ('investments', 'investments.update', 'Update Investments', 'Edit investment holdings', TRUE),
  ('investments', 'investments.delete', 'Delete Investments', 'Delete investment holdings', TRUE),

  -- loans CRUD
  ('loans', 'loans.create', 'Create Loans', 'Create debt plans', TRUE),
  ('loans', 'loans.read', 'Read Loans', 'View debt plans', TRUE),
  ('loans', 'loans.update', 'Update Loans', 'Edit debt plans', TRUE),
  ('loans', 'loans.delete', 'Delete Loans', 'Delete debt plans', TRUE),

  --fbudgets CRUD
  ('budgets', 'budgets.create', 'Create Budgets', 'Create budgets', TRUE),
  ('budgets', 'budgets.read', 'Read Budgets', 'View budgets', TRUE),
  ('budgets', 'budgets.update', 'Update Budgets', 'Edit budgets', TRUE),
  ('budgets', 'budgets.delete', 'Delete Budgets', 'Delete budgets', TRUE),

  -- goals CRUD
  ('goals', 'goals.create', 'Create Goals', 'Create savings goals', TRUE),
  ('goals', 'goals.read', 'Read Goals', 'View savings goals', TRUE),
  ('goals', 'goals.update', 'Update Goals', 'Edit savings goals', TRUE),
  ('goals', 'goals.delete', 'Delete Goals', 'Delete savings goals', TRUE),

  -- categories CRUD
  ('categories', 'categories.create', 'Create Categories', 'Create spend categories', TRUE),
  ('categories', 'categories.read', 'Read Categories', 'View spend categories', TRUE),
  ('categories', 'categories.update', 'Update Categories', 'Edit spend categories', TRUE),
  ('categories', 'categories.delete', 'Delete Categories', 'Delete spend categories', TRUE),

  -- reports
  ('reports', 'reports.read', 'Read Reports', 'View financial reports', TRUE),

  -- spaces CRUD
  ('spaces', 'spaces.create', 'Create Spaces', 'Create collaborative spaces', TRUE),
  ('spaces', 'spaces.read', 'Read Spaces', 'View collaborative spaces', TRUE),
  ('spaces', 'spaces.update', 'Update Spaces', 'Edit collaborative spaces', TRUE),
  ('spaces', 'spaces.delete', 'Delete Spaces', 'Delete collaborative spaces', TRUE),

  -- ai CRUD
  ('ai', 'ai.create', 'Create AI content', 'Send AI messages and upload documents', TRUE),
  ('ai', 'ai.read', 'Read AI', 'View AI conversations and memory', TRUE),
  ('ai', 'ai.update', 'Update AI', 'Rename, pin, and configure AI', TRUE),
  ('ai', 'ai.delete', 'Delete AI', 'Delete AI conversations and documents', TRUE),

  -- settings
  ('settings', 'settings.read', 'Read Settings', 'View profile and settings', TRUE),
  ('settings', 'settings.update', 'Update Settings', 'Change profile and settings', TRUE),

  -- sync
  ('sync', 'sync.create', 'Sync push', 'Push offline changes to the server', TRUE),
  ('sync', 'sync.read', 'Sync pull', 'Pull changes from the server', TRUE)
ON CONFLICT (code) DO NOTHING;

-- Down Migration
DELETE FROM permissions
WHERE code IN (
  'dashboard.read',
  'accounts.create', 'accounts.read', 'accounts.update', 'accounts.delete',
  'expenses.create', 'expenses.read', 'expenses.update', 'expenses.delete',
  'recurring.create', 'recurring.read', 'recurring.update', 'recurring.delete',
  'investments.create', 'investments.read', 'investments.update', 'investments.delete',
  'loans.create', 'loans.read', 'loans.update', 'loans.delete',
  'budgets.create', 'budgets.read', 'budgets.update', 'budgets.delete',
  'goals.create', 'goals.read', 'goals.update', 'goals.delete',
  'categories.create', 'categories.read', 'categories.update', 'categories.delete',
  'reports.read',
  'spaces.create', 'spaces.read', 'spaces.update', 'spaces.delete',
  'ai.create', 'ai.read', 'ai.update', 'ai.delete',
  'settings.read', 'settings.update',
  'sync.create', 'sync.read'
);
