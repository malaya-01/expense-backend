# Migration Guide

## Understanding the `.sql` Extension Issue

`node-pg-migrate` stores migration names in the database **without** the `.sql` extension, even though files on disk have the `.sql` extension. This is the expected behavior:

- **File on disk**: `1771837427055_create-all-table.sql`
- **Database record**: `1771837427055_create-all-table` (no `.sql`)

## Creating Migrations

Use the wrapper script to ensure consistency:

```bash
npm run migration:create <migration-name>
```

**Example:**
```bash
npm run migration:create add-user-roles
```

This will:
- Create a properly named migration file
- Ensure the name is stored correctly in the database (without `.sql` extension)
- Validate the migration name format

## Running Migrations

The migration runner automatically verifies consistency before running:

```bash
# Run pending migrations
npm run migration:up

# Rollback last migration
npm run migration:down
```

The runner will:
- Check for mismatches between database records and filesystem files
- Prevent running migrations if there are inconsistencies
- Show clear error messages if issues are found

## Checking Migration Status

To see what migrations are recorded vs. what files exist:

```bash
npm run migration:check
```

This shows:
- Migrations in the database
- Migration files in the filesystem
- Any mismatches between them

## Fixing Migration Issues

If you have mismatched migrations:

**Option 1: Update database record to match filename**
```bash
npm run migration:fix "old-name" "new-name"
```

**Option 2: Delete stale migration record**
```bash
npm run migration:delete "migration-name"
```

## Important Notes

1. **Never manually rename migration files** after they've been run - update the database record instead
2. **Always use the wrapper scripts** (`npm run migration:create`) instead of calling `node-pg-migrate` directly
3. **Check migrations** before running them if you suspect issues: `npm run migration:check`

## Troubleshooting

**Problem**: Migration keeps tracking old file even though it's recorded in database

**Solution**: 
1. Run `npm run migration:check` to see the mismatch
2. Use `npm run migration:fix` to update the database record
3. Or use `npm run migration:delete` to remove stale records

**Problem**: New migrations aren't being recognized

**Solution**:
1. Ensure you're using `npm run migration:create` (not direct node-pg-migrate)
2. Check that the migration file has `.sql` extension
3. Verify the database record matches the filename (without `.sql`)
