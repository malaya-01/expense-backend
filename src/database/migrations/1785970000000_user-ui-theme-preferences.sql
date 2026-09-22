-- Up Migration
CREATE TABLE IF NOT EXISTS user_ui_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  active_theme_id TEXT NOT NULL DEFAULT 'preset:midnight',
  custom_themes JSONB NOT NULL DEFAULT '[]'::jsonb,
  sync_version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

DROP TRIGGER IF EXISTS trg_bump_sync_version_ui_prefs ON user_ui_preferences;
CREATE TRIGGER trg_bump_sync_version_ui_prefs
  BEFORE UPDATE ON user_ui_preferences
  FOR EACH ROW EXECUTE FUNCTION bump_sync_version();

-- Down Migration
DROP TRIGGER IF EXISTS trg_bump_sync_version_ui_prefs ON user_ui_preferences;
DROP TABLE IF EXISTS user_ui_preferences;
