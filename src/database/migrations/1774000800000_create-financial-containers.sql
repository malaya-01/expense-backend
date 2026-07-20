-- Up Migration
CREATE TABLE IF NOT EXISTS financial_containers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    name VARCHAR(100) NOT NULL,
    type VARCHAR(30) NOT NULL,
    balance DECIMAL(14,2) NOT NULL DEFAULT 0,
    currency VARCHAR(3) DEFAULT 'USD',
    institution VARCHAR(255),
    color VARCHAR(7),
    notes TEXT,
    include_in_net_worth BOOLEAN DEFAULT TRUE,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,

    CONSTRAINT financial_containers_type_check CHECK (
        type IN (
            'cash',
            'wallet',
            'bank',
            'credit_card',
            'investment',
            'gold',
            'crypto',
            'loan',
            'receivable',
            'payable',
            'other'
        )
    ),
    UNIQUE(user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_financial_containers_user_id
    ON financial_containers(user_id);

CREATE INDEX IF NOT EXISTS idx_financial_containers_type
    ON financial_containers(type);

CREATE INDEX IF NOT EXISTS idx_financial_containers_deleted_at
    ON financial_containers(deleted_at);

-- Down Migration
DROP INDEX IF EXISTS idx_financial_containers_deleted_at;
DROP INDEX IF EXISTS idx_financial_containers_type;
DROP INDEX IF EXISTS idx_financial_containers_user_id;
DROP TABLE IF EXISTS financial_containers;
