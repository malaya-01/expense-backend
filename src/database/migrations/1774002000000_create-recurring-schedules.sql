-- Up Migration
CREATE TABLE IF NOT EXISTS recurring_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    name VARCHAR(140) NOT NULL,
    transaction_type VARCHAR(20) NOT NULL
        CHECK (transaction_type IN ('expense', 'income', 'transfer')),
    amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
    description VARCHAR(500) NOT NULL,
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    source_container_id UUID REFERENCES financial_containers(id) ON DELETE RESTRICT,
    destination_container_id UUID REFERENCES financial_containers(id) ON DELETE RESTRICT,
    currency VARCHAR(3),
    exchange_rate NUMERIC(18, 8),
    frequency VARCHAR(20) NOT NULL
        CHECK (frequency IN (
          'daily', 'weekly', 'biweekly', 'monthly',
          'quarterly', 'semiannual', 'annual'
        )),
    start_date DATE NOT NULL,
    end_date DATE,
    next_execution DATE NOT NULL,
    execution_mode VARCHAR(20) NOT NULL DEFAULT 'review'
        CHECK (execution_mode IN ('review', 'automatic')),
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('draft', 'active', 'paused', 'completed', 'archived')),
    notes TEXT,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT recurring_dates_check CHECK (
      end_date IS NULL OR end_date >= start_date
    ),
    CONSTRAINT recurring_containers_check CHECK (
      (transaction_type = 'expense' AND source_container_id IS NOT NULL)
      OR (transaction_type = 'income' AND destination_container_id IS NOT NULL)
      OR (
        transaction_type = 'transfer'
        AND source_container_id IS NOT NULL
        AND destination_container_id IS NOT NULL
        AND source_container_id <> destination_container_id
      )
    )
);

CREATE TABLE IF NOT EXISTS recurring_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schedule_id UUID NOT NULL REFERENCES recurring_schedules(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    scheduled_for DATE NOT NULL,
    transaction_id UUID REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
    status VARCHAR(20) NOT NULL
        CHECK (status IN ('pending', 'successful', 'failed', 'skipped')),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    UNIQUE (schedule_id, scheduled_for)
);

CREATE INDEX IF NOT EXISTS idx_recurring_schedules_due
    ON recurring_schedules(status, execution_mode, next_execution)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recurring_schedules_user
    ON recurring_schedules(user_id, status, next_execution);
CREATE INDEX IF NOT EXISTS idx_recurring_executions_schedule
    ON recurring_executions(schedule_id, scheduled_for DESC);

-- Down Migration
DROP INDEX IF EXISTS idx_recurring_executions_schedule;
DROP INDEX IF EXISTS idx_recurring_schedules_user;
DROP INDEX IF EXISTS idx_recurring_schedules_due;
DROP TABLE IF EXISTS recurring_executions;
DROP TABLE IF EXISTS recurring_schedules;
