-- Up Migration
CREATE TABLE IF NOT EXISTS permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module VARCHAR(80) NOT NULL,
    code VARCHAR(120) NOT NULL UNIQUE,
    name VARCHAR(120) NOT NULL,
    description TEXT,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_permissions_module_active
    ON permissions(module)
    WHERE is_active = TRUE AND is_deleted = FALSE;

CREATE INDEX IF NOT EXISTS idx_permissions_default_active
    ON permissions(is_default)
    WHERE is_active = TRUE AND is_deleted = FALSE;


CREATE TABLE IF NOT EXISTS permission_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    effect VARCHAR(10) NOT NULL CHECK (effect IN ('GRANT', 'REVOKE')),
    changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    UNIQUE (user_id, permission_id)
);

CREATE INDEX IF NOT EXISTS idx_permission_overrides_user_active
    ON permission_overrides(user_id)
    WHERE is_active = TRUE AND is_deleted = FALSE;

CREATE INDEX IF NOT EXISTS idx_permission_overrides_changed_by
    ON permission_overrides(changed_by)
    WHERE changed_by IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_permission_overrides_changed_by;
DROP INDEX IF EXISTS idx_permission_overrides_user_active;
DROP TABLE IF EXISTS permission_overrides;
DROP INDEX IF EXISTS idx_permissions_default_active;
DROP INDEX IF EXISTS idx_permissions_module_active;
DROP TABLE IF EXISTS permissions;