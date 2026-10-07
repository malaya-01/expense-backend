-- Up Migration
ALTER TABLE face_login_profiles
  ADD COLUMN IF NOT EXISTS template JSONB;

-- Down Migration
ALTER TABLE face_login_profiles
  DROP COLUMN IF EXISTS template;
