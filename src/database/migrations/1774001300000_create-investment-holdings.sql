-- Up Migration
CREATE TABLE IF NOT EXISTS investment_holdings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    container_id UUID REFERENCES financial_containers(id) ON DELETE SET NULL,

    name VARCHAR(150) NOT NULL,
    symbol VARCHAR(30),
    asset_type VARCHAR(30) NOT NULL DEFAULT 'other',
    quantity DECIMAL(18, 8) NOT NULL DEFAULT 0,
    avg_cost DECIMAL(18, 8) NOT NULL DEFAULT 0,
    current_price DECIMAL(18, 8) NOT NULL DEFAULT 0,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    notes TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,

    CONSTRAINT investment_holdings_asset_type_check CHECK (
        asset_type IN (
            'stock',
            'mutual_fund',
            'etf',
            'gold',
            'crypto',
            'bond',
            'real_estate',
            'other'
        )
    ),
    CONSTRAINT investment_holdings_quantity_non_negative CHECK (quantity >= 0),
    CONSTRAINT investment_holdings_avg_cost_non_negative CHECK (avg_cost >= 0),
    CONSTRAINT investment_holdings_price_non_negative CHECK (current_price >= 0)
);

CREATE INDEX IF NOT EXISTS idx_investment_holdings_user_id
    ON investment_holdings(user_id);
CREATE INDEX IF NOT EXISTS idx_investment_holdings_container_id
    ON investment_holdings(container_id);
CREATE INDEX IF NOT EXISTS idx_investment_holdings_deleted_at
    ON investment_holdings(deleted_at);
CREATE INDEX IF NOT EXISTS idx_investment_holdings_asset_type
    ON investment_holdings(asset_type);

COMMENT ON TABLE investment_holdings IS 'Individual investment positions with cost basis and mark-to-market value';
COMMENT ON COLUMN investment_holdings.container_id IS 'Optional linked investment/gold/crypto container; balance can sync from holdings';

-- Down Migration
DROP INDEX IF EXISTS idx_investment_holdings_asset_type;
DROP INDEX IF EXISTS idx_investment_holdings_deleted_at;
DROP INDEX IF EXISTS idx_investment_holdings_container_id;
DROP INDEX IF EXISTS idx_investment_holdings_user_id;
DROP TABLE IF EXISTS investment_holdings;
