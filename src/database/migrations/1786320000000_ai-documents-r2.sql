-- Up Migration
-- AI-advisor documents move from ai_documents.content (BYTEA) to R2
-- (users/{userId}/documents/{YYYY}/{MM}/{slug}-{id}.{ext}) via stored_files.
-- content stays as a fallback when R2 is not configured and for legacy rows
-- until `npm run storage:migrate-layout` moves them.
ALTER TABLE ai_documents
  ADD COLUMN IF NOT EXISTS stored_file_id UUID
    REFERENCES stored_files(id) ON DELETE SET NULL;

ALTER TABLE ai_documents
  ALTER COLUMN content DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_documents_stored_file
  ON ai_documents (stored_file_id)
  WHERE stored_file_id IS NOT NULL;

COMMENT ON COLUMN ai_documents.content IS
  'Legacy / fallback inline bytes. NULL when the file lives in R2 (stored_file_id) or after deletion.';

-- Down Migration
-- WARNING: rows whose bytes already live in R2 (or were released on delete)
-- get an empty placeholder so NOT NULL can be restored; the R2 objects are
-- not copied back into Postgres.
DROP INDEX IF EXISTS idx_ai_documents_stored_file;
UPDATE ai_documents SET content = ''::bytea WHERE content IS NULL;
ALTER TABLE ai_documents
  ALTER COLUMN content SET NOT NULL;
ALTER TABLE ai_documents
  DROP COLUMN IF EXISTS stored_file_id;
