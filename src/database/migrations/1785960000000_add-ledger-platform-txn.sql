-- Up Migration
ALTER TABLE ledger_transactions
  ADD COLUMN IF NOT EXISTS platform VARCHAR(64),
  ADD COLUMN IF NOT EXISTS platform_txn_id VARCHAR(128);

CREATE INDEX IF NOT EXISTS idx_ledger_transactions_platform_txn_id
  ON ledger_transactions (user_id, platform_txn_id)
  WHERE platform_txn_id IS NOT NULL AND deleted_at IS NULL;

-- Down Migration
DROP INDEX IF EXISTS idx_ledger_transactions_platform_txn_id;

ALTER TABLE ledger_transactions
  DROP COLUMN IF EXISTS platform_txn_id,
  DROP COLUMN IF EXISTS platform;
