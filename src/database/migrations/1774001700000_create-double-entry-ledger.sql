-- Up Migration
CREATE TABLE IF NOT EXISTS ledger_journals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    transaction_id UUID REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
    reversal_of_journal_id UUID REFERENCES ledger_journals(id) ON DELETE RESTRICT,
    description VARCHAR(500) NOT NULL,
    source_module VARCHAR(50) NOT NULL DEFAULT 'transactions',
    correlation_id UUID NOT NULL DEFAULT gen_random_uuid(),
    status VARCHAR(20) NOT NULL DEFAULT 'posted'
        CHECK (status IN ('posted', 'reversed')),
    posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ledger_journal_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    journal_id UUID NOT NULL REFERENCES ledger_journals(id) ON DELETE RESTRICT,
    container_id UUID REFERENCES financial_containers(id) ON DELETE RESTRICT,
    account_code VARCHAR(120),
    debit_base NUMERIC(18, 4) NOT NULL DEFAULT 0 CHECK (debit_base >= 0),
    credit_base NUMERIC(18, 4) NOT NULL DEFAULT 0 CHECK (credit_base >= 0),
    native_amount NUMERIC(18, 4) NOT NULL CHECK (native_amount > 0),
    currency VARCHAR(3) NOT NULL,
    sequence_number SMALLINT NOT NULL CHECK (sequence_number > 0),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ledger_journal_line_side_check CHECK (
        (debit_base > 0 AND credit_base = 0)
        OR (credit_base > 0 AND debit_base = 0)
    ),
    CONSTRAINT ledger_journal_line_account_check CHECK (
        container_id IS NOT NULL OR account_code IS NOT NULL
    ),
    UNIQUE (journal_id, sequence_number)
);

CREATE INDEX IF NOT EXISTS idx_ledger_journals_user_posted
    ON ledger_journals(user_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_journals_transaction
    ON ledger_journals(transaction_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_journals_correlation
    ON ledger_journals(correlation_id);
CREATE INDEX IF NOT EXISTS idx_ledger_journal_lines_journal
    ON ledger_journal_lines(journal_id);
CREATE INDEX IF NOT EXISTS idx_ledger_journal_lines_container
    ON ledger_journal_lines(container_id);

CREATE OR REPLACE FUNCTION validate_balanced_journal()
RETURNS TRIGGER AS $$
DECLARE
    target_journal UUID;
    line_count INTEGER;
    imbalance NUMERIC(18, 4);
BEGIN
    target_journal := COALESCE(NEW.journal_id, OLD.journal_id);
    SELECT COUNT(*), COALESCE(SUM(debit_base - credit_base), 0)
      INTO line_count, imbalance
      FROM ledger_journal_lines
     WHERE journal_id = target_journal;

    IF line_count < 2 OR ABS(imbalance) > 0.005 THEN
        RAISE EXCEPTION
          'Journal % is not balanced (lines %, imbalance %)',
          target_journal, line_count, imbalance;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_balanced_journal
    ON ledger_journal_lines;
CREATE CONSTRAINT TRIGGER trg_validate_balanced_journal
AFTER INSERT OR UPDATE OR DELETE ON ledger_journal_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_balanced_journal();

CREATE OR REPLACE FUNCTION prevent_journal_line_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
      'Posted journal lines are immutable; create a reversing journal instead';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_journal_line_update
    ON ledger_journal_lines;
CREATE TRIGGER trg_prevent_journal_line_update
BEFORE UPDATE OR DELETE ON ledger_journal_lines
FOR EACH ROW EXECUTE FUNCTION prevent_journal_line_mutation();

-- Backfill balanced journals for transactions created before this migration.
INSERT INTO ledger_journals (
    user_id, transaction_id, description, source_module, status, posted_at
)
SELECT
    t.user_id,
    t.id,
    t.description,
    'migration_backfill',
    CASE WHEN t.deleted_at IS NULL THEN 'posted' ELSE 'reversed' END,
    COALESCE(t.created_at, NOW())
FROM ledger_transactions t
WHERE NOT EXISTS (
    SELECT 1 FROM ledger_journals j WHERE j.transaction_id = t.id
);

INSERT INTO ledger_journal_lines (
    journal_id, container_id, account_code, debit_base, credit_base,
    native_amount, currency, sequence_number, metadata
)
SELECT
    j.id,
    CASE
      WHEN t.type = 'income' THEN t.destination_container_id
      WHEN t.type = 'transfer' THEN t.destination_container_id
      ELSE NULL
    END,
    CASE
      WHEN t.type = 'expense'
        THEN 'expense:' || COALESCE(t.category_id::text, 'uncategorized')
      ELSE NULL
    END,
    COALESCE(t.amount_base, t.amount),
    0,
    CASE
      WHEN t.type = 'transfer'
        THEN t.amount * COALESCE(t.exchange_rate, 1)
      ELSE t.amount
    END,
    t.currency,
    1,
    jsonb_build_object('backfilled', true)
FROM ledger_transactions t
JOIN ledger_journals j ON j.transaction_id = t.id
WHERE NOT EXISTS (
    SELECT 1 FROM ledger_journal_lines l WHERE l.journal_id = j.id
)
UNION ALL
SELECT
    j.id,
    CASE
      WHEN t.type IN ('expense', 'transfer') THEN t.source_container_id
      ELSE NULL
    END,
    CASE
      WHEN t.type = 'income'
        THEN 'income:' || COALESCE(t.category_id::text, 'uncategorized')
      ELSE NULL
    END,
    0,
    COALESCE(t.amount_base, t.amount),
    t.amount,
    t.currency,
    2,
    jsonb_build_object('backfilled', true)
FROM ledger_transactions t
JOIN ledger_journals j ON j.transaction_id = t.id
WHERE NOT EXISTS (
    SELECT 1 FROM ledger_journal_lines l WHERE l.journal_id = j.id
);

INSERT INTO ledger_journals (
    user_id, transaction_id, reversal_of_journal_id, description,
    source_module, status, posted_at
)
SELECT
    original.user_id,
    original.transaction_id,
    original.id,
    'Historical deletion reversal: ' || original.description,
    'migration_backfill',
    'posted',
    t.deleted_at
FROM ledger_journals original
JOIN ledger_transactions t ON t.id = original.transaction_id
WHERE t.deleted_at IS NOT NULL
  AND original.reversal_of_journal_id IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM ledger_journals reversal
    WHERE reversal.reversal_of_journal_id = original.id
  );

INSERT INTO ledger_journal_lines (
    journal_id, container_id, account_code, debit_base, credit_base,
    native_amount, currency, sequence_number, metadata
)
SELECT
    reversal.id,
    line.container_id,
    line.account_code,
    line.credit_base,
    line.debit_base,
    line.native_amount,
    line.currency,
    line.sequence_number,
    line.metadata || jsonb_build_object(
      'backfilled', true,
      'reversal_of_journal_id', original.id::text
    )
FROM ledger_journals reversal
JOIN ledger_journals original ON original.id = reversal.reversal_of_journal_id
JOIN ledger_journal_lines line ON line.journal_id = original.id
WHERE reversal.source_module = 'migration_backfill'
  AND NOT EXISTS (
    SELECT 1
    FROM ledger_journal_lines existing
    WHERE existing.journal_id = reversal.id
  );

-- Down Migration
DROP TRIGGER IF EXISTS trg_prevent_journal_line_update
    ON ledger_journal_lines;
DROP FUNCTION IF EXISTS prevent_journal_line_mutation();
DROP TRIGGER IF EXISTS trg_validate_balanced_journal
    ON ledger_journal_lines;
DROP FUNCTION IF EXISTS validate_balanced_journal();
DROP INDEX IF EXISTS idx_ledger_journal_lines_container;
DROP INDEX IF EXISTS idx_ledger_journal_lines_journal;
DROP INDEX IF EXISTS idx_ledger_journals_correlation;
DROP INDEX IF EXISTS idx_ledger_journals_transaction;
DROP INDEX IF EXISTS idx_ledger_journals_user_posted;
DROP TABLE IF EXISTS ledger_journal_lines;
DROP TABLE IF EXISTS ledger_journals;
