-- Up Migration
CREATE TABLE IF NOT EXISTS loans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    container_id UUID NOT NULL REFERENCES financial_containers(id) ON DELETE RESTRICT,
    name VARCHAR(120) NOT NULL,
    lender VARCHAR(160),
    principal NUMERIC(14, 2) NOT NULL CHECK (principal > 0),
    annual_interest_rate NUMERIC(7, 4) NOT NULL DEFAULT 0
        CHECK (annual_interest_rate >= 0),
    interest_type VARCHAR(20) NOT NULL DEFAULT 'fixed'
        CHECK (interest_type IN ('fixed', 'floating', 'simple', 'compound')),
    term_months INTEGER NOT NULL CHECK (term_months > 0 AND term_months <= 1200),
    start_date DATE NOT NULL,
    payment_day SMALLINT CHECK (payment_day BETWEEN 1 AND 31),
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'closed', 'archived')),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    UNIQUE (user_id, container_id)
);

CREATE INDEX IF NOT EXISTS idx_loans_user_status
    ON loans(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loans_container
    ON loans(container_id);

-- Down Migration
DROP INDEX IF EXISTS idx_loans_container;
DROP INDEX IF EXISTS idx_loans_user_status;
DROP TABLE IF EXISTS loans;
