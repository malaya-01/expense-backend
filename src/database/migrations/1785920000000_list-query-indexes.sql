-- Speed up the dashboard / ledger list query:
-- WHERE user_id = $1 AND deleted_at IS NULL ORDER BY date DESC, created_at DESC
CREATE INDEX IF NOT EXISTS idx_ledger_transactions_user_active_date
  ON ledger_transactions (user_id, date DESC, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_financial_containers_user_active_name
  ON financial_containers (user_id, name)
  WHERE deleted_at IS NULL AND space_id IS NULL;

-- Down Migration
DROP INDEX IF EXISTS idx_financial_containers_user_active_name;
DROP INDEX IF EXISTS idx_ledger_transactions_user_active_date;
