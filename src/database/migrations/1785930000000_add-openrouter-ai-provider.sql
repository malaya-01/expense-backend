-- Allow OpenRouter as a first-class BYOK AI provider.
ALTER TABLE user_ai_provider_configs
  DROP CONSTRAINT IF EXISTS user_ai_provider_configs_provider_check;

ALTER TABLE user_ai_provider_configs
  ADD CONSTRAINT user_ai_provider_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'local', 'vertex', 'openrouter'));

ALTER TABLE user_ai_preferences
  DROP CONSTRAINT IF EXISTS user_ai_preferences_provider_check;

ALTER TABLE user_ai_preferences
  ADD CONSTRAINT user_ai_preferences_provider_check
  CHECK (
    active_provider IS NULL
    OR active_provider IN ('openai', 'anthropic', 'local', 'vertex', 'openrouter')
  );

-- OpenRouter model slugs can be longer than legacy OpenAI ids.
ALTER TABLE user_ai_provider_configs
  ALTER COLUMN model TYPE VARCHAR(200);

ALTER TABLE user_ai_preferences
  ALTER COLUMN active_model TYPE VARCHAR(200);

ALTER TABLE ai_conversations
  ALTER COLUMN model TYPE VARCHAR(200);

ALTER TABLE ai_messages
  ALTER COLUMN model TYPE VARCHAR(200);

-- Down
-- ALTER TABLE user_ai_provider_configs DROP CONSTRAINT IF EXISTS user_ai_provider_configs_provider_check;
-- ALTER TABLE user_ai_provider_configs ADD CONSTRAINT user_ai_provider_configs_provider_check CHECK (provider IN ('openai', 'anthropic', 'local', 'vertex'));
-- ALTER TABLE user_ai_preferences DROP CONSTRAINT IF EXISTS user_ai_preferences_provider_check;
-- ALTER TABLE user_ai_preferences ADD CONSTRAINT user_ai_preferences_provider_check CHECK (active_provider IS NULL OR active_provider IN ('openai', 'anthropic', 'local', 'vertex'));
