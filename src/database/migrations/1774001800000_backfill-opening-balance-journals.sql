-- Up Migration
ALTER TABLE ledger_journals
    ADD COLUMN IF NOT EXISTS reference_container_id UUID
        REFERENCES financial_containers(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_ledger_journals_reference_container
    ON ledger_journals(reference_container_id, created_at DESC);

WITH native_effects AS (
    SELECT
        t.source_container_id AS container_id,
        SUM(
          CASE
            WHEN t.type IN ('expense', 'transfer') THEN -t.amount
            ELSE 0
          END
        ) AS effect
    FROM ledger_transactions t
    WHERE t.deleted_at IS NULL AND t.source_container_id IS NOT NULL
    GROUP BY t.source_container_id
    UNION ALL
    SELECT
        t.destination_container_id AS container_id,
        SUM(
          CASE
            WHEN t.type = 'income' THEN t.amount
            WHEN t.type = 'transfer'
              THEN t.amount * COALESCE(t.exchange_rate, 1)
            ELSE 0
          END
        ) AS effect
    FROM ledger_transactions t
    WHERE t.deleted_at IS NULL AND t.destination_container_id IS NOT NULL
    GROUP BY t.destination_container_id
),
container_effects AS (
    SELECT container_id, SUM(effect) AS native_effect
    FROM native_effects
    GROUP BY container_id
),
opening_values AS (
    SELECT
        c.*,
        c.balance - (
          CASE
            WHEN c.type IN ('credit_card', 'loan', 'payable')
              THEN -COALESCE(e.native_effect, 0)
            ELSE COALESCE(e.native_effect, 0)
          END
        ) AS opening_balance
    FROM financial_containers c
    LEFT JOIN container_effects e ON e.container_id = c.id
)
INSERT INTO ledger_journals (
    user_id, description, source_module, reference_container_id, metadata,
    posted_at
)
SELECT
    o.user_id,
    'Opening balance: ' || o.name,
    'migration_opening_balance',
    o.id,
    jsonb_build_object(
      'opening_balance', o.opening_balance,
      'base_conversion', 'native_amount_fallback'
    ),
    o.created_at
FROM opening_values o
WHERE ABS(o.opening_balance) > 0.005
  AND NOT EXISTS (
    SELECT 1
    FROM ledger_journals j
    WHERE j.reference_container_id = o.id
      AND j.source_module IN ('accounts', 'migration_opening_balance')
  );

WITH native_effects AS (
    SELECT
        t.source_container_id AS container_id,
        SUM(
          CASE
            WHEN t.type IN ('expense', 'transfer') THEN -t.amount
            ELSE 0
          END
        ) AS effect
    FROM ledger_transactions t
    WHERE t.deleted_at IS NULL AND t.source_container_id IS NOT NULL
    GROUP BY t.source_container_id
    UNION ALL
    SELECT
        t.destination_container_id AS container_id,
        SUM(
          CASE
            WHEN t.type = 'income' THEN t.amount
            WHEN t.type = 'transfer'
              THEN t.amount * COALESCE(t.exchange_rate, 1)
            ELSE 0
          END
        ) AS effect
    FROM ledger_transactions t
    WHERE t.deleted_at IS NULL AND t.destination_container_id IS NOT NULL
    GROUP BY t.destination_container_id
),
container_effects AS (
    SELECT container_id, SUM(effect) AS native_effect
    FROM native_effects
    GROUP BY container_id
),
opening_values AS (
    SELECT
        c.*,
        c.balance - (
          CASE
            WHEN c.type IN ('credit_card', 'loan', 'payable')
              THEN -COALESCE(e.native_effect, 0)
            ELSE COALESCE(e.native_effect, 0)
          END
        ) AS opening_balance
    FROM financial_containers c
    LEFT JOIN container_effects e ON e.container_id = c.id
)
INSERT INTO ledger_journal_lines (
    journal_id, container_id, account_code, debit_base, credit_base,
    native_amount, currency, sequence_number, metadata
)
SELECT
    j.id,
    o.id,
    NULL,
    CASE
      WHEN (
        o.type NOT IN ('credit_card', 'loan', 'payable')
        AND o.opening_balance > 0
      ) OR (
        o.type IN ('credit_card', 'loan', 'payable')
        AND o.opening_balance < 0
      )
      THEN ABS(o.opening_balance)
      ELSE 0
    END,
    CASE
      WHEN (
        o.type NOT IN ('credit_card', 'loan', 'payable')
        AND o.opening_balance > 0
      ) OR (
        o.type IN ('credit_card', 'loan', 'payable')
        AND o.opening_balance < 0
      )
      THEN 0
      ELSE ABS(o.opening_balance)
    END,
    ABS(o.opening_balance),
    o.currency,
    1,
    jsonb_build_object('backfilled', true)
FROM opening_values o
JOIN ledger_journals j
  ON j.reference_container_id = o.id
 AND j.source_module = 'migration_opening_balance'
WHERE ABS(o.opening_balance) > 0.005
  AND NOT EXISTS (
    SELECT 1 FROM ledger_journal_lines l WHERE l.journal_id = j.id
  )
UNION ALL
SELECT
    j.id,
    NULL,
    'equity:opening_balance',
    CASE
      WHEN (
        o.type NOT IN ('credit_card', 'loan', 'payable')
        AND o.opening_balance > 0
      ) OR (
        o.type IN ('credit_card', 'loan', 'payable')
        AND o.opening_balance < 0
      )
      THEN 0
      ELSE ABS(o.opening_balance)
    END,
    CASE
      WHEN (
        o.type NOT IN ('credit_card', 'loan', 'payable')
        AND o.opening_balance > 0
      ) OR (
        o.type IN ('credit_card', 'loan', 'payable')
        AND o.opening_balance < 0
      )
      THEN ABS(o.opening_balance)
      ELSE 0
    END,
    ABS(o.opening_balance),
    o.currency,
    2,
    jsonb_build_object('backfilled', true)
FROM opening_values o
JOIN ledger_journals j
  ON j.reference_container_id = o.id
 AND j.source_module = 'migration_opening_balance'
WHERE ABS(o.opening_balance) > 0.005
  AND NOT EXISTS (
    SELECT 1 FROM ledger_journal_lines l WHERE l.journal_id = j.id
  );

-- Down Migration
DROP INDEX IF EXISTS idx_ledger_journals_reference_container;
ALTER TABLE ledger_journals
    DROP COLUMN IF EXISTS metadata,
    DROP COLUMN IF EXISTS reference_container_id;
