-- Up Migration
CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  config JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stored_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  object_key TEXT NOT NULL,
  public_token TEXT NOT NULL UNIQUE,
  mime_type TEXT,
  size_bytes INTEGER,
  original_filename TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stored_files_user_kind
  ON stored_files (user_id, kind);

CREATE TABLE IF NOT EXISTS face_login_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  object_key TEXT NOT NULL,
  preview_token TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Down Migration
DROP TABLE IF EXISTS face_login_profiles;
DROP TABLE IF EXISTS stored_files;
DROP TABLE IF EXISTS app_config;
