-- Up Migration
-- Allow sync_client_ops rows to be claimed as 'pending' before the change is
-- applied, so concurrent pushes of the same client_op_id cannot double-apply.
-- The original inline CHECK was auto-named; drop whichever status check exists.
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'sync_client_ops'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE sync_client_ops DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE sync_client_ops
  ADD CONSTRAINT sync_client_ops_status_check
  CHECK (status IN ('pending', 'applied', 'conflict', 'error'));

-- Down Migration
UPDATE sync_client_ops SET status = 'error' WHERE status = 'pending';

ALTER TABLE sync_client_ops
  DROP CONSTRAINT IF EXISTS sync_client_ops_status_check;

ALTER TABLE sync_client_ops
  ADD CONSTRAINT sync_client_ops_status_check
  CHECK (status IN ('applied', 'conflict', 'error'));
