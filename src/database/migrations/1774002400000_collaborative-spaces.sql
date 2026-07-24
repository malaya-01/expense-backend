-- Up Migration
-- Collaborative Spaces: isolated multi-member financial workspaces

ALTER TABLE financial_containers
  ADD COLUMN IF NOT EXISTS space_id UUID;

-- Drop personal-only unique name; replace with partial uniques
ALTER TABLE financial_containers
  DROP CONSTRAINT IF EXISTS financial_containers_user_id_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_containers_personal_name
  ON financial_containers (user_id, name)
  WHERE deleted_at IS NULL AND space_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_containers_space_name
  ON financial_containers (space_id, name)
  WHERE deleted_at IS NULL AND space_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS collaborative_spaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL,
  slug VARCHAR(140) NOT NULL,
  description TEXT,
  icon VARCHAR(50),
  color VARCHAR(7),
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  wallet_container_id UUID REFERENCES financial_containers(id) ON DELETE SET NULL,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (slug)
);

CREATE INDEX IF NOT EXISTS idx_collaborative_spaces_created_by
  ON collaborative_spaces (created_by)
  WHERE deleted_at IS NULL;

ALTER TABLE financial_containers
  DROP CONSTRAINT IF EXISTS financial_containers_space_id_fkey;

ALTER TABLE financial_containers
  ADD CONSTRAINT financial_containers_space_id_fkey
  FOREIGN KEY (space_id) REFERENCES collaborative_spaces(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS space_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID NOT NULL REFERENCES collaborative_spaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'member'
    CHECK (role IN ('owner', 'admin', 'member', 'guest')),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'invited', 'left', 'removed')),
  display_name VARCHAR(120),
  joined_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (space_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_space_members_user
  ON space_members (user_id, status);

CREATE INDEX IF NOT EXISTS idx_space_members_space
  ON space_members (space_id, status);

CREATE TABLE IF NOT EXISTS space_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID NOT NULL REFERENCES collaborative_spaces(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'member'
    CHECK (role IN ('admin', 'member', 'guest')),
  token VARCHAR(64) NOT NULL UNIQUE,
  invited_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_space_invites_email
  ON space_invites (lower(email), expires_at)
  WHERE revoked_at IS NULL AND accepted_at IS NULL;

CREATE TABLE IF NOT EXISTS space_favorites (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_id UUID NOT NULL REFERENCES collaborative_spaces(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, space_id)
);

CREATE TABLE IF NOT EXISTS space_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID NOT NULL REFERENCES collaborative_spaces(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  amount DECIMAL(14,2) NOT NULL CHECK (amount > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  payer_member_id UUID NOT NULL REFERENCES space_members(id) ON DELETE RESTRICT,
  split_method VARCHAR(20) NOT NULL DEFAULT 'equal'
    CHECK (split_method IN ('equal', 'exact', 'percentage', 'shares')),
  category VARCHAR(100),
  expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  receipt_name VARCHAR(180),
  receipt_mime_type VARCHAR(120),
  receipt_base64 TEXT,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  link_to_personal BOOLEAN NOT NULL DEFAULT FALSE,
  personal_container_id UUID REFERENCES financial_containers(id) ON DELETE SET NULL,
  personal_transaction_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_space_expenses_space_date
  ON space_expenses (space_id, expense_date DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS space_expense_splits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID NOT NULL REFERENCES space_expenses(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES space_members(id) ON DELETE RESTRICT,
  share_value DECIMAL(14,4),
  owed_amount DECIMAL(14,2) NOT NULL CHECK (owed_amount >= 0),
  UNIQUE (expense_id, member_id)
);

CREATE TABLE IF NOT EXISTS space_settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID NOT NULL REFERENCES collaborative_spaces(id) ON DELETE CASCADE,
  from_member_id UUID NOT NULL REFERENCES space_members(id) ON DELETE RESTRICT,
  to_member_id UUID NOT NULL REFERENCES space_members(id) ON DELETE RESTRICT,
  amount DECIMAL(14,2) NOT NULL CHECK (amount > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  status VARCHAR(20) NOT NULL DEFAULT 'completed'
    CHECK (status IN ('pending', 'completed', 'cancelled', 'scheduled')),
  notes TEXT,
  proof_name VARCHAR(180),
  proof_mime_type VARCHAR(120),
  proof_base64 TEXT,
  scheduled_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  link_to_personal BOOLEAN NOT NULL DEFAULT FALSE,
  personal_container_id UUID REFERENCES financial_containers(id) ON DELETE SET NULL,
  personal_transaction_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CHECK (from_member_id <> to_member_id)
);

CREATE INDEX IF NOT EXISTS idx_space_settlements_space
  ON space_settlements (space_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS space_budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID NOT NULL REFERENCES collaborative_spaces(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  amount DECIMAL(14,2) NOT NULL CHECK (amount > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  period_type VARCHAR(20) NOT NULL DEFAULT 'monthly'
    CHECK (period_type IN ('weekly', 'monthly', 'yearly')),
  category VARCHAR(100),
  notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS space_goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID NOT NULL REFERENCES collaborative_spaces(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  target_amount DECIMAL(14,2) NOT NULL CHECK (target_amount > 0),
  current_amount DECIMAL(14,2) NOT NULL DEFAULT 0 CHECK (current_amount >= 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  target_date DATE,
  notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS space_goal_contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id UUID NOT NULL REFERENCES space_goals(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES space_members(id) ON DELETE RESTRICT,
  amount DECIMAL(14,2) NOT NULL CHECK (amount > 0),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS space_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID NOT NULL REFERENCES collaborative_spaces(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type VARCHAR(60) NOT NULL,
  title VARCHAR(200) NOT NULL,
  summary TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_space_activity_space
  ON space_activity (space_id, created_at DESC);

CREATE TABLE IF NOT EXISTS space_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_id UUID REFERENCES collaborative_spaces(id) ON DELETE CASCADE,
  kind VARCHAR(60) NOT NULL,
  title VARCHAR(200) NOT NULL,
  body TEXT,
  href VARCHAR(300),
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_space_notifications_user
  ON space_notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS space_sync_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_id UUID REFERENCES collaborative_spaces(id) ON DELETE CASCADE,
  client_op_id VARCHAR(80) NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'synced', 'failed', 'conflict')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  synced_at TIMESTAMPTZ,
  UNIQUE (user_id, client_op_id)
);

-- Down Migration
DROP TABLE IF EXISTS space_sync_outbox;
DROP TABLE IF EXISTS space_notifications;
DROP TABLE IF EXISTS space_activity;
DROP TABLE IF EXISTS space_goal_contributions;
DROP TABLE IF EXISTS space_goals;
DROP TABLE IF EXISTS space_budgets;
DROP TABLE IF EXISTS space_settlements;
DROP TABLE IF EXISTS space_expense_splits;
DROP TABLE IF EXISTS space_expenses;
DROP TABLE IF EXISTS space_favorites;
DROP TABLE IF EXISTS space_invites;
DROP TABLE IF EXISTS space_members;
ALTER TABLE financial_containers DROP CONSTRAINT IF EXISTS financial_containers_space_id_fkey;
DROP TABLE IF EXISTS collaborative_spaces;
DROP INDEX IF EXISTS idx_financial_containers_space_name;
DROP INDEX IF EXISTS idx_financial_containers_personal_name;
ALTER TABLE financial_containers DROP COLUMN IF EXISTS space_id;
ALTER TABLE financial_containers
  ADD CONSTRAINT financial_containers_user_id_name_key UNIQUE (user_id, name);
