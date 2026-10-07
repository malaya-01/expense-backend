-- Up Migration
-- Rows are soft-deleted (deleted_at), so uniqueness must only apply to live
-- rows; otherwise a deleted category/budget/goal name can never be reused.

ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_user_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_user_name_active
  ON categories (user_id, name)
  WHERE deleted_at IS NULL;

ALTER TABLE budgets DROP CONSTRAINT IF EXISTS budgets_user_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_budgets_user_name_active
  ON budgets (user_id, name)
  WHERE deleted_at IS NULL;

ALTER TABLE goals DROP CONSTRAINT IF EXISTS goals_user_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_goals_user_name_active
  ON goals (user_id, name)
  WHERE deleted_at IS NULL;

ALTER TABLE loans DROP CONSTRAINT IF EXISTS loans_user_id_container_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_loans_user_container_active
  ON loans (user_id, container_id)
  WHERE deleted_at IS NULL;

-- 1785920000000_list-query-indexes.sql had no "-- Up Migration" marker, so
-- node-pg-migrate ran its down section too and the indexes were dropped
-- immediately. Recreate them.
CREATE INDEX IF NOT EXISTS idx_ledger_transactions_user_active_date
  ON ledger_transactions (user_id, date DESC, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_financial_containers_user_active_name
  ON financial_containers (user_id, name)
  WHERE deleted_at IS NULL AND space_id IS NULL;

-- Down Migration
DROP INDEX IF EXISTS uq_loans_user_container_active;
DROP INDEX IF EXISTS uq_goals_user_name_active;
DROP INDEX IF EXISTS uq_budgets_user_name_active;
DROP INDEX IF EXISTS uq_categories_user_name_active;
