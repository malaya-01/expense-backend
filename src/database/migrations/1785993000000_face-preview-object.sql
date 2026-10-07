-- Up Migration
ALTER TABLE face_login_profiles
  ADD COLUMN IF NOT EXISTS preview_object_key TEXT;

-- Down Migration
ALTER TABLE face_login_profiles
  DROP COLUMN IF EXISTS preview_object_key;
