-- Up Migration
-- Face login has been removed (passwordless 1:N match on a client-computed
-- descriptor was not a safe authentication factor). Drop all face data.
-- Face preview photos may have been registered as public media; remove those
-- rows so their /api/media/<token> links stop resolving. The underlying R2
-- objects (face-login/ and face_preview/ prefixes) must be purged manually.
DELETE FROM stored_files WHERE kind = 'face_preview';

DROP TABLE IF EXISTS face_login_profiles;

-- Down Migration
-- Recreates the empty table as it existed after 1785990000000, 1785992000000
-- and 1785993000000. Deleted face data and stored_files rows are not restored.
CREATE TABLE IF NOT EXISTS face_login_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  object_key TEXT NOT NULL,
  preview_token TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  template JSONB,
  preview_object_key TEXT
);
