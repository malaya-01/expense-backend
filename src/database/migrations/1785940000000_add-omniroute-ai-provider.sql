-- Built-in OmniRoute free provider + per-user daily successful request quota.
ALTER TABLE user_ai_provider_configs
  DROP CONSTRAINT IF EXISTS user_ai_provider_configs_provider_check;

ALTER TABLE user_ai_provider_configs
  ADD CONSTRAINT user_ai_provider_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'local', 'vertex', 'openrouter', 'omniroute'));

ALTER TABLE user_ai_preferences
  DROP CONSTRAINT IF EXISTS user_ai_preferences_provider_check;

ALTER TABLE user_ai_preferences
  ADD CONSTRAINT user_ai_preferences_provider_check
  CHECK (
    active_provider IS NULL
    OR active_provider IN ('openai', 'anthropic', 'local', 'vertex', 'openrouter', 'omniroute')
  );

CREATE TABLE IF NOT EXISTS ai_omniroute_usage_daily (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  usage_date DATE NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_ai_omniroute_usage_daily_date
  ON ai_omniroute_usage_daily (usage_date);

-- Down
-- DROP TABLE IF EXISTS ai_omniroute_usage_daily;
-- ALTER TABLE user_ai_provider_configs DROP CONSTRAINT IF EXISTS user_ai_provider_configs_provider_check;
-- ALTER TABLE user_ai_provider_configs ADD CONSTRAINT user_ai_provider_configs_provider_check CHECK (provider IN ('openai', 'anthropic', 'local', 'vertex', 'openrouter'));
-- ALTER TABLE user_ai_preferences DROP CONSTRAINT IF EXISTS user_ai_preferences_provider_check;
-- ALTER TABLE user_ai_preferences ADD CONSTRAINT user_ai_preferences_provider_check CHECK (active_provider IS NULL OR active_provider IN ('openai', 'anthropic', 'local', 'vertex', 'openrouter'));
