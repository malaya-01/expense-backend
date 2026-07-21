-- Up Migration
CREATE TABLE IF NOT EXISTS user_ai_provider_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(40) NOT NULL,
    display_name VARCHAR(120),
    model VARCHAR(120),
    base_url TEXT,
    project_id VARCHAR(255),
    location VARCHAR(120),
    credentials_ciphertext BYTEA,
    credentials_nonce BYTEA,
    credentials_tag BYTEA,
    credentials_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_connected BOOLEAN NOT NULL DEFAULT FALSE,
    last_tested_at TIMESTAMPTZ,
    last_test_status VARCHAR(40),
    last_test_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT user_ai_provider_configs_provider_check CHECK (
        provider IN ('openai', 'anthropic', 'local', 'vertex')
    ),
    UNIQUE (user_id, provider)
);

CREATE TABLE IF NOT EXISTS user_ai_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    active_provider VARCHAR(40),
    active_model VARCHAR(120),
    master_prompt TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT user_ai_preferences_provider_check CHECK (
        active_provider IS NULL OR active_provider IN ('openai', 'anthropic', 'local', 'vertex')
    )
);

CREATE TABLE IF NOT EXISTS ai_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL DEFAULT 'New conversation',
    provider VARCHAR(40),
    model VARCHAR(120),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ai_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    tool_activity JSONB NOT NULL DEFAULT '[]'::jsonb,
    citations JSONB NOT NULL DEFAULT '[]'::jsonb,
    proposal_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    provider VARCHAR(40),
    model VARCHAR(120),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT ai_messages_role_check CHECK (
        role IN ('user', 'assistant', 'system', 'tool')
    )
);

CREATE TABLE IF NOT EXISTS ai_action_proposals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES ai_conversations(id) ON DELETE SET NULL,
    message_id UUID REFERENCES ai_messages(id) ON DELETE SET NULL,
    action_type VARCHAR(80) NOT NULL,
    title VARCHAR(200) NOT NULL,
    summary TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(30) NOT NULL DEFAULT 'pending',
    expires_at TIMESTAMPTZ NOT NULL,
    executed_at TIMESTAMPTZ,
    result JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT ai_action_proposals_status_check CHECK (
        status IN ('pending', 'confirmed', 'rejected', 'expired', 'failed')
    )
);

CREATE INDEX IF NOT EXISTS idx_user_ai_provider_configs_user
    ON user_ai_provider_configs(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_user
    ON ai_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation
    ON ai_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_ai_action_proposals_user_status
    ON ai_action_proposals(user_id, status);

-- Down Migration
DROP INDEX IF EXISTS idx_ai_action_proposals_user_status;
DROP INDEX IF EXISTS idx_ai_messages_conversation;
DROP INDEX IF EXISTS idx_ai_conversations_user;
DROP INDEX IF EXISTS idx_user_ai_provider_configs_user;
DROP TABLE IF EXISTS ai_action_proposals;
DROP TABLE IF EXISTS ai_messages;
DROP TABLE IF EXISTS ai_conversations;
DROP TABLE IF EXISTS user_ai_preferences;
DROP TABLE IF EXISTS user_ai_provider_configs;
