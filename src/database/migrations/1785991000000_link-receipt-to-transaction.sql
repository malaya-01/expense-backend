-- Up Migration
ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS ledger_transaction_id UUID
    REFERENCES ledger_transactions(id) ON DELETE SET NULL;

ALTER TABLE ledger_transactions
  ADD COLUMN IF NOT EXISTS receipt_id UUID
    REFERENCES receipts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS receipt_url TEXT,
  ADD COLUMN IF NOT EXISTS receipt_mime TEXT;

CREATE INDEX IF NOT EXISTS idx_receipts_ledger_transaction
  ON receipts (ledger_transaction_id);

-- Down Migration
DROP INDEX IF EXISTS idx_receipts_ledger_transaction;
ALTER TABLE ledger_transactions
  DROP COLUMN IF EXISTS receipt_mime,
  DROP COLUMN IF EXISTS receipt_url,
  DROP COLUMN IF EXISTS receipt_id;
ALTER TABLE receipts
  DROP COLUMN IF EXISTS ledger_transaction_id;
