-- Up Migration
CREATE TABLE IF NOT EXISTS ledger_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    type VARCHAR(20) NOT NULL,
    amount DECIMAL(14,2) NOT NULL CHECK (amount > 0),
    description VARCHAR(500) NOT NULL,
    date DATE NOT NULL DEFAULT CURRENT_DATE,

    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    source_container_id UUID REFERENCES financial_containers(id) ON DELETE RESTRICT,
    destination_container_id UUID REFERENCES financial_containers(id) ON DELETE RESTRICT,

    merchant VARCHAR(255),
    currency VARCHAR(3) DEFAULT 'USD',
    notes TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,

    CONSTRAINT ledger_transactions_type_check CHECK (
        type IN ('expense', 'income', 'transfer')
    ),
    CONSTRAINT ledger_transactions_containers_check CHECK (
        (type = 'expense' AND source_container_id IS NOT NULL)
        OR (type = 'income' AND destination_container_id IS NOT NULL)
        OR (
            type = 'transfer'
            AND source_container_id IS NOT NULL
            AND destination_container_id IS NOT NULL
            AND source_container_id <> destination_container_id
        )
    )
);

CREATE INDEX IF NOT EXISTS idx_ledger_transactions_user_id
    ON ledger_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_ledger_transactions_date
    ON ledger_transactions(date);
CREATE INDEX IF NOT EXISTS idx_ledger_transactions_source
    ON ledger_transactions(source_container_id);
CREATE INDEX IF NOT EXISTS idx_ledger_transactions_destination
    ON ledger_transactions(destination_container_id);
CREATE INDEX IF NOT EXISTS idx_ledger_transactions_deleted_at
    ON ledger_transactions(deleted_at);

-- Down Migration
DROP INDEX IF EXISTS idx_ledger_transactions_deleted_at;
DROP INDEX IF EXISTS idx_ledger_transactions_destination;
DROP INDEX IF EXISTS idx_ledger_transactions_source;
DROP INDEX IF EXISTS idx_ledger_transactions_date;
DROP INDEX IF EXISTS idx_ledger_transactions_user_id;
DROP TABLE IF EXISTS ledger_transactions;
