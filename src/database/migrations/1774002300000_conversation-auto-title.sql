-- Up Migration
ALTER TABLE ai_conversations
  ADD COLUMN IF NOT EXISTS auto_titled_at TIMESTAMPTZ;

-- Down Migration
ALTER TABLE ai_conversations
  DROP COLUMN IF EXISTS auto_titled_at;
