-- Up Migration
-- Per-user / per-space R2 layout (users/{userId}/..., spaces/{spaceId}/...).
-- Adds integrity / lifecycle metadata to stored_files, a direct
-- receipts -> stored_files link so relocating an object never breaks the
-- receipt or its /api/media/<token> URL, and moves space expense receipts
-- from space_expenses.receipt_base64 to stored files.
ALTER TABLE stored_files
  ADD COLUMN IF NOT EXISTS space_id UUID
    REFERENCES collaborative_spaces(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sha256 TEXT,
  ADD COLUMN IF NOT EXISTS legacy_object_key TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

COMMENT ON COLUMN stored_files.legacy_object_key IS
  'Pre-1786300000000 key ({kind}/{userId}/{token}.{ext}) before relocation to users/{userId}/...';
COMMENT ON COLUMN stored_files.deleted_at IS
  'Set when the owning record was deleted; object removal is best-effort and retried while set.';

CREATE INDEX IF NOT EXISTS idx_stored_files_user_sha256
  ON stored_files (user_id, sha256)
  WHERE sha256 IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_stored_files_orphaned
  ON stored_files (deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stored_files_object_key
  ON stored_files (object_key);

CREATE INDEX IF NOT EXISTS idx_stored_files_space
  ON stored_files (space_id)
  WHERE space_id IS NOT NULL;

-- Space receipts belong to the space, not the uploader: deleting the
-- uploader's users row must not cascade them away. Personal files are purged
-- explicitly (ObjectStorageService.purgeUserFiles) before any hard delete;
-- rows left with neither user nor space are cleaned by the orphan job.
DO $$
DECLARE fk_name TEXT;
BEGIN
  FOR fk_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_attribute att
      ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
    WHERE con.conrelid = 'stored_files'::regclass
      AND con.contype = 'f'
      AND att.attname = 'user_id'
  LOOP
    EXECUTE format('ALTER TABLE stored_files DROP CONSTRAINT %I', fk_name);
  END LOOP;
END $$;
ALTER TABLE stored_files
  ADD CONSTRAINT stored_files_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE space_expenses
  ADD COLUMN IF NOT EXISTS receipt_file_id UUID
    REFERENCES stored_files(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_space_expenses_receipt_file
  ON space_expenses (receipt_file_id)
  WHERE receipt_file_id IS NOT NULL;

COMMENT ON COLUMN space_expenses.receipt_base64 IS
  'Legacy inline receipt. New uploads go to R2 (receipt_file_id); run npm run storage:migrate-layout to move old rows.';

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS stored_file_id UUID
    REFERENCES stored_files(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_receipts_stored_file
  ON receipts (stored_file_id);

UPDATE receipts r
SET stored_file_id = f.id
FROM stored_files f
WHERE r.stored_file_id IS NULL
  AND f.object_key = r.file_path
  AND f.user_id = r.user_id;

-- Down Migration
-- Rows already marked deleted must not become servable again once the
-- deleted_at column is gone. Relocated objects keep their new keys (the
-- previous code serves any object_key).
-- WARNING: space receipts already moved to R2 lose their link
-- (receipt_file_id) on rollback; receipt_base64 cannot be restored in SQL.
DELETE FROM stored_files WHERE deleted_at IS NOT NULL;
DROP INDEX IF EXISTS idx_space_expenses_receipt_file;
ALTER TABLE space_expenses
  DROP COLUMN IF EXISTS receipt_file_id;
ALTER TABLE stored_files
  DROP CONSTRAINT IF EXISTS stored_files_user_id_fkey;
DELETE FROM stored_files WHERE user_id IS NULL;
ALTER TABLE stored_files
  ADD CONSTRAINT stored_files_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
DROP INDEX IF EXISTS idx_stored_files_space;
DROP INDEX IF EXISTS idx_receipts_stored_file;
ALTER TABLE receipts
  DROP COLUMN IF EXISTS stored_file_id;
DROP INDEX IF EXISTS idx_stored_files_object_key;
DROP INDEX IF EXISTS idx_stored_files_orphaned;
DROP INDEX IF EXISTS idx_stored_files_user_sha256;
ALTER TABLE stored_files
  DROP COLUMN IF EXISTS deleted_at,
  DROP COLUMN IF EXISTS updated_at,
  DROP COLUMN IF EXISTS legacy_object_key,
  DROP COLUMN IF EXISTS sha256,
  DROP COLUMN IF EXISTS space_id;
