-- Ensure CRUD catalog rows are on by default, and promote the first user
-- when no super-admin exists yet.

UPDATE permissions
SET is_default = TRUE
WHERE is_deleted = FALSE
  AND is_active = TRUE
  AND code ~* '\.(create|read|update|delete)$';

UPDATE users
SET is_admin = TRUE, updated_at = NOW()
WHERE id = (
  SELECT id FROM users
  WHERE deleted_at IS NULL
  ORDER BY created_at ASC
  LIMIT 1
)
AND NOT EXISTS (
  SELECT 1 FROM users
  WHERE is_admin = TRUE AND deleted_at IS NULL
);
