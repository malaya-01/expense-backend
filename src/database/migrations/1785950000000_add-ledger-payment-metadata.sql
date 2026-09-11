-- Up Migration
ALTER TABLE ledger_transactions
  ADD COLUMN IF NOT EXISTS payment_method VARCHAR(32),
  ADD COLUMN IF NOT EXISTS upi_vpa VARCHAR(255),
  ADD COLUMN IF NOT EXISTS upi_txn_id VARCHAR(128),
  ADD COLUMN IF NOT EXISTS payment_status VARCHAR(32),
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ledger_transactions_upi_txn_id
  ON ledger_transactions (user_id, upi_txn_id)
  WHERE upi_txn_id IS NOT NULL AND deleted_at IS NULL;

-- Down Migration
DROP INDEX IF EXISTS idx_ledger_transactions_upi_txn_id;

ALTER TABLE ledger_transactions
  DROP COLUMN IF EXISTS paid_at,
  DROP COLUMN IF EXISTS payment_status,
  DROP COLUMN IF EXISTS upi_txn_id,
  DROP COLUMN IF EXISTS upi_vpa,
  DROP COLUMN IF EXISTS payment_method;
