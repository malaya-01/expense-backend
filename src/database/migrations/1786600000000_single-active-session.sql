-- Up Migration
-- One signed-in device per account: a new login revokes every other session
-- with revoked_reason = 'replaced' so the old device can tell the user why it
-- was signed out (instead of a generic "session expired").
ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS revoked_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_active
  ON user_sessions (user_id)
  WHERE revoked_at IS NULL;

-- Down Migration
DROP INDEX IF EXISTS idx_user_sessions_user_active;
ALTER TABLE user_sessions DROP COLUMN IF EXISTS revoked_reason;
