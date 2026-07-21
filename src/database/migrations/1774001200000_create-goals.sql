-- Up Migration
CREATE TABLE IF NOT EXISTS goals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    container_id UUID REFERENCES financial_containers(id) ON DELETE SET NULL,

    name VARCHAR(100) NOT NULL,
    goal_type VARCHAR(30) NOT NULL DEFAULT 'other',
    target_amount DECIMAL(14, 2) NOT NULL,
    current_amount DECIMAL(14, 2) NOT NULL DEFAULT 0,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    target_date DATE,
    notes TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,

    CONSTRAINT goals_type_check CHECK (
        goal_type IN (
            'emergency_fund',
            'vacation',
            'house',
            'marriage',
            'education',
            'retirement',
            'vehicle',
            'business',
            'other'
        )
    ),
    CONSTRAINT goals_target_positive CHECK (target_amount > 0),
    CONSTRAINT goals_current_non_negative CHECK (current_amount >= 0),
    UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_goals_user_id ON goals(user_id);
CREATE INDEX IF NOT EXISTS idx_goals_container_id ON goals(container_id);
CREATE INDEX IF NOT EXISTS idx_goals_deleted_at ON goals(deleted_at);

COMMENT ON TABLE goals IS 'Savings / life goals with progress toward a target amount';
COMMENT ON COLUMN goals.container_id IS 'Optional linked financial container; when set, progress uses that container balance';
COMMENT ON COLUMN goals.current_amount IS 'Manual progress when no container is linked';

-- Down Migration
DROP INDEX IF EXISTS idx_goals_deleted_at;
DROP INDEX IF EXISTS idx_goals_container_id;
DROP INDEX IF EXISTS idx_goals_user_id;
DROP TABLE IF EXISTS goals;
