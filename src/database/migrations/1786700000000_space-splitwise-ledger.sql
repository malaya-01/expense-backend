-- Up Migration
-- Splitwise-style payer contributions, receipt lines, and per-user account links.

ALTER TABLE space_expenses
  DROP CONSTRAINT IF EXISTS space_expenses_split_method_check;

ALTER TABLE space_expenses
  ADD CONSTRAINT space_expenses_split_method_check
  CHECK (split_method IN ('equal', 'exact', 'percentage', 'shares', 'itemized'));

ALTER TABLE space_expenses
  ADD COLUMN IF NOT EXISTS line_items JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE space_expenses
  ADD COLUMN IF NOT EXISTS client_op_id VARCHAR(80);

CREATE UNIQUE INDEX IF NOT EXISTS idx_space_expenses_client_op
  ON space_expenses (space_id, client_op_id)
  WHERE client_op_id IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE space_settlements
  ADD COLUMN IF NOT EXISTS client_op_id VARCHAR(80);

CREATE UNIQUE INDEX IF NOT EXISTS idx_space_settlements_client_op
  ON space_settlements (space_id, client_op_id)
  WHERE client_op_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS space_expense_payers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID NOT NULL REFERENCES space_expenses(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES space_members(id) ON DELETE RESTRICT,
  paid_amount DECIMAL(14,2) NOT NULL CHECK (paid_amount > 0),
  UNIQUE (expense_id, member_id)
);

INSERT INTO space_expense_payers (expense_id, member_id, paid_amount)
SELECT id, payer_member_id, amount
FROM space_expenses
ON CONFLICT (expense_id, member_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_space_expense_payers_member
  ON space_expense_payers (member_id);

CREATE TABLE IF NOT EXISTS space_ledger_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID NOT NULL REFERENCES collaborative_spaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expense_id UUID REFERENCES space_expenses(id) ON DELETE CASCADE,
  settlement_id UUID REFERENCES space_settlements(id) ON DELETE CASCADE,
  kind VARCHAR(32) NOT NULL
    CHECK (kind IN ('payment_out', 'receivable_up', 'settlement_out', 'settlement_in')),
  container_id UUID REFERENCES financial_containers(id) ON DELETE SET NULL,
  transaction_id UUID,
  amount DECIMAL(14,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (expense_id IS NOT NULL AND settlement_id IS NULL)
    OR (expense_id IS NULL AND settlement_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_space_ledger_links_expense
  ON space_ledger_links (expense_id)
  WHERE expense_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_space_ledger_links_settlement
  ON space_ledger_links (settlement_id)
  WHERE settlement_id IS NOT NULL;

-- Down Migration
DROP TABLE IF EXISTS space_ledger_links;
DROP TABLE IF EXISTS space_expense_payers;

DROP INDEX IF EXISTS idx_space_settlements_client_op;
ALTER TABLE space_settlements DROP COLUMN IF EXISTS client_op_id;

DROP INDEX IF EXISTS idx_space_expenses_client_op;
ALTER TABLE space_expenses DROP COLUMN IF EXISTS client_op_id;
ALTER TABLE space_expenses DROP COLUMN IF EXISTS line_items;

UPDATE space_expenses SET split_method = 'exact' WHERE split_method = 'itemized';

ALTER TABLE space_expenses
  DROP CONSTRAINT IF EXISTS space_expenses_split_method_check;

ALTER TABLE space_expenses
  ADD CONSTRAINT space_expenses_split_method_check
  CHECK (split_method IN ('equal', 'exact', 'percentage', 'shares'));
