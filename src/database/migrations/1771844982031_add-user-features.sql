-- Up Migration
CREATE TABLE IF NOT EXISTS user_features (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- feature_id UUID NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    feature_name VARCHAR(50) NOT NULL,
    feature_description TEXT,
    feature_value JSONB,
    feature_type VARCHAR(50) NOT NULL,
    feature_default_value JSONB,
    feature_allowed_values JSONB,
    feature_allowed_values_type VARCHAR(50) NOT NULL,
    feature_allowed_values_type_description TEXT,
    feature_allowed_values_type_description_text TEXT,
    feature_allowed_values_type_description_text_text TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    is_delete BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- CREATE INDEX idx_user_features_user_id ON user_features(user_id);
-- CREATE INDEX idx_user_features_feature_id ON user_features(feature_id);
-- Down Migration