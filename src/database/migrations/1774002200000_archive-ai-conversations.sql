-- Up Migration
ALTER TABLE ai_conversations
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

ALTER TABLE ai_documents
  ADD COLUMN IF NOT EXISTS analysis_confidence NUMERIC(5, 2),
  ADD COLUMN IF NOT EXISTS related_transactions JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_ai_conversations_user_archived
  ON ai_conversations(user_id, archived_at, updated_at DESC)
  WHERE deleted_at IS NULL;

-- Down Migration
DROP INDEX IF EXISTS idx_ai_conversations_user_archived;
ALTER TABLE ai_documents
  DROP COLUMN IF EXISTS related_transactions,
  DROP COLUMN IF EXISTS analysis_confidence;
ALTER TABLE ai_conversations DROP COLUMN IF EXISTS archived_at;
