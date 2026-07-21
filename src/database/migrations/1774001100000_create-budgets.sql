-- Up Migration
CREATE TABLE IF NOT EXISTS budgets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,

    name VARCHAR(100) NOT NULL,
    amount DECIMAL(14, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    period_type VARCHAR(20) NOT NULL DEFAULT 'monthly',
    notes TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,

    CONSTRAINT budgets_period_type_check CHECK (
        period_type IN ('weekly', 'monthly', 'yearly')
    ),
    CONSTRAINT budgets_amount_positive CHECK (amount > 0),
    UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_budgets_user_id
    ON budgets(user_id);

CREATE INDEX IF NOT EXISTS idx_budgets_category_id
    ON budgets(category_id);

CREATE INDEX IF NOT EXISTS idx_budgets_deleted_at
    ON budgets(deleted_at);

COMMENT ON TABLE budgets IS 'Spending envelopes evaluated against ledger expenses in the current period';
COMMENT ON COLUMN budgets.category_id IS 'NULL = overall spending budget across all expense categories';
COMMENT ON COLUMN budgets.amount IS 'Budget limit stored in the budget currency (usually user base currency)';
COMMENT ON COLUMN budgets.period_type IS 'Rolling window: weekly (Mon–Sun), monthly (calendar month), yearly (calendar year)';

-- Down Migration
DROP INDEX IF EXISTS idx_budgets_deleted_at;
DROP INDEX IF EXISTS idx_budgets_category_id;
DROP INDEX IF EXISTS idx_budgets_user_id;
DROP TABLE IF EXISTS budgets;
