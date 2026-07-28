-- Up Migration

-- Sync version on personal-finance + settings tables
ALTER TABLE financial_containers ADD COLUMN IF NOT EXISTS sync_version INT NOT NULL DEFAULT 1;
ALTER TABLE ledger_transactions ADD COLUMN IF NOT EXISTS sync_version INT NOT NULL DEFAULT 1;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS sync_version INT NOT NULL DEFAULT 1;
ALTER TABLE budgets ADD COLUMN IF NOT EXISTS sync_version INT NOT NULL DEFAULT 1;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS sync_version INT NOT NULL DEFAULT 1;
ALTER TABLE investment_holdings ADD COLUMN IF NOT EXISTS sync_version INT NOT NULL DEFAULT 1;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS sync_version INT NOT NULL DEFAULT 1;
ALTER TABLE recurring_schedules ADD COLUMN IF NOT EXISTS sync_version INT NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sync_version INT NOT NULL DEFAULT 1;
ALTER TABLE user_ai_preferences ADD COLUMN IF NOT EXISTS sync_version INT NOT NULL DEFAULT 1;
ALTER TABLE user_ai_preferences ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE ai_memories ADD COLUMN IF NOT EXISTS sync_version INT NOT NULL DEFAULT 1;
ALTER TABLE ai_memories ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION bump_sync_version() RETURNS TRIGGER AS $$
BEGIN
  NEW.sync_version := COALESCE(OLD.sync_version, 1) + 1;
  IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
    NEW.updated_at := NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'financial_containers',
    'ledger_transactions',
    'categories',
    'budgets',
    'goals',
    'investment_holdings',
    'loans',
    'recurring_schedules',
    'users',
    'user_ai_preferences',
    'ai_memories'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_bump_sync_version ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_bump_sync_version
       BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION bump_sync_version()',
      t
    );
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS sync_client_ops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_op_id VARCHAR(120) NOT NULL,
  entity_type VARCHAR(60) NOT NULL,
  entity_id UUID,
  op VARCHAR(40) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'applied'
    CHECK (status IN ('applied', 'conflict', 'error')),
  result_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, client_op_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_client_ops_user
  ON sync_client_ops(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_sync_state (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id VARCHAR(120) NOT NULL,
  pull_cursor TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, device_id)
);

CREATE TABLE IF NOT EXISTS user_notification_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  sync_version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

DROP TRIGGER IF EXISTS trg_bump_sync_version_notif ON user_notification_preferences;
CREATE TRIGGER trg_bump_sync_version_notif
  BEFORE UPDATE ON user_notification_preferences
  FOR EACH ROW EXECUTE FUNCTION bump_sync_version();

-- Down Migration
DROP TRIGGER IF EXISTS trg_bump_sync_version_notif ON user_notification_preferences;
DROP TABLE IF EXISTS user_notification_preferences;
DROP TABLE IF EXISTS user_sync_state;
DROP TABLE IF EXISTS sync_client_ops;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'financial_containers',
    'ledger_transactions',
    'categories',
    'budgets',
    'goals',
    'investment_holdings',
    'loans',
    'recurring_schedules',
    'users',
    'user_ai_preferences',
    'ai_memories'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_bump_sync_version ON %I', t);
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS bump_sync_version();

ALTER TABLE ai_memories DROP COLUMN IF EXISTS deleted_at;
ALTER TABLE ai_memories DROP COLUMN IF EXISTS sync_version;
ALTER TABLE user_ai_preferences DROP COLUMN IF EXISTS sync_version;
ALTER TABLE users DROP COLUMN IF EXISTS sync_version;
ALTER TABLE recurring_schedules DROP COLUMN IF EXISTS sync_version;
ALTER TABLE loans DROP COLUMN IF EXISTS sync_version;
ALTER TABLE investment_holdings DROP COLUMN IF EXISTS sync_version;
ALTER TABLE goals DROP COLUMN IF EXISTS sync_version;
ALTER TABLE budgets DROP COLUMN IF EXISTS sync_version;
ALTER TABLE categories DROP COLUMN IF EXISTS sync_version;
ALTER TABLE ledger_transactions DROP COLUMN IF EXISTS sync_version;
ALTER TABLE financial_containers DROP COLUMN IF EXISTS sync_version;
