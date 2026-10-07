-- Up Migration
-- Per-user app preferences (date/number format, first day of week,
-- transaction defaults, appearance). Stored on users so the existing offline
-- `user_settings` sync entity (which maps to the users row) carries them.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Session list / "sign out other devices" filter on live sessions per user.
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_live
  ON user_sessions (user_id, updated_at DESC)
  WHERE revoked_at IS NULL;

-- Down Migration
DROP INDEX IF EXISTS idx_user_sessions_user_live;
ALTER TABLE users DROP COLUMN IF EXISTS preferences;
