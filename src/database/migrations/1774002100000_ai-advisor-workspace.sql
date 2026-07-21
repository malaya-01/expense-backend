-- Up Migration
ALTER TABLE ai_conversations
  ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_message_preview TEXT;

CREATE INDEX IF NOT EXISTS idx_ai_conversations_user_pinned
  ON ai_conversations(user_id, pinned_at DESC NULLS LAST, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ai_conversations_user_search
  ON ai_conversations(user_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ai_action_proposals_user_pending
  ON ai_action_proposals(user_id, created_at DESC)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS ai_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES ai_conversations(id) ON DELETE SET NULL,
    name VARCHAR(180) NOT NULL,
    mime_type VARCHAR(120) NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    content BYTEA NOT NULL,
    detected_type VARCHAR(80),
    summary TEXT,
    extracted_sections JSONB NOT NULL DEFAULT '[]'::jsonb,
    suggested_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
    related_accounts JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(30) NOT NULL DEFAULT 'ready'
        CHECK (status IN ('uploading', 'analyzing', 'ready', 'failed')),
    analysis_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_documents_user_recent
  ON ai_documents(user_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- Down Migration
DROP INDEX IF EXISTS idx_ai_documents_user_recent;
DROP TABLE IF EXISTS ai_documents;
DROP INDEX IF EXISTS idx_ai_action_proposals_user_pending;
DROP INDEX IF EXISTS idx_ai_conversations_user_search;
DROP INDEX IF EXISTS idx_ai_conversations_user_pinned;
ALTER TABLE ai_conversations
  DROP COLUMN IF EXISTS last_message_preview,
  DROP COLUMN IF EXISTS pinned_at;
