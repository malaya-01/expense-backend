-- Up Migration
ALTER TABLE user_ai_preferences
    ADD COLUMN IF NOT EXISTS memory_enabled BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS ai_memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    source VARCHAR(30) NOT NULL DEFAULT 'user',
    source_conversation_id UUID REFERENCES ai_conversations(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ai_memories_source_check CHECK (source IN ('user', 'conversation'))
);

CREATE INDEX IF NOT EXISTS idx_ai_memories_user_updated
    ON ai_memories(user_id, updated_at DESC);

-- Down Migration
DROP INDEX IF EXISTS idx_ai_memories_user_updated;
DROP TABLE IF EXISTS ai_memories;
ALTER TABLE user_ai_preferences DROP COLUMN IF EXISTS memory_enabled;
