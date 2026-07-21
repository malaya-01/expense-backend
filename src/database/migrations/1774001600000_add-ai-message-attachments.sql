-- Up Migration
ALTER TABLE ai_messages
    ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Down Migration
ALTER TABLE ai_messages DROP COLUMN IF EXISTS attachments;
