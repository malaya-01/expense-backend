/**
 * Enhanced migration runner that ensures consistency
 * Verifies migration files match database records before running
 *
 * Usage:
 *   node scripts/run-migrations.js up
 *   node scripts/run-migrations.js down
 *
 * Use Supabase:
 *   Set USE_SUPABASE=true in .env (loads .env.supabase)
 */

const fs = require('fs');
const path = require('path');
const { existsSync } = fs;

function resolveEnvPath(fileName) {
  const candidates = [
    path.resolve(process.cwd(), fileName),
    path.resolve(process.cwd(), 'expense-backend', fileName),
  ];
  return candidates.find(existsSync);
}

const basePath = resolveEnvPath('.env');
require('dotenv').config(basePath ? { path: basePath } : undefined);

const useSupabase =
  String(process.env.USE_SUPABASE || '')
    .trim()
    .toLowerCase() === 'true';
if (useSupabase) {
  const supabasePath = resolveEnvPath('.env.supabase');
  if (supabasePath) {
    require('dotenv').config({ path: supabasePath, override: true });
  }
}

const { execSync } = require('child_process');
const { Pool } = require('pg');

const useSsl =
  String(process.env.PG_SSL || '')
    .trim()
    .toLowerCase() === 'true' || useSupabase;

const pool = new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT),
  user: process.env.PG_USERNAME,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
  ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

const migrationsDir = path.join(__dirname, '../src/database/migrations');
const command = process.argv[2] || 'up';

async function checkAndShowMigrations() {
  let isValid = true;
  let pendingMigrations = [];

  try {
    // Check if pgmigrations table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'pgmigrations'
      );
    `);

    // Get migration files from filesystem
    const files = fs.readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort();
    
    if (!tableCheck.rows[0].exists) {
      console.log('ℹ️  pgmigrations table does not exist yet. This is normal for the first migration.');
      console.log(`\n⚠️  WARNING: ${files.length} migration(s) will be run:`);
      files.forEach((file, index) => {
        console.log(`   ${index + 1}. ${file}`);
      });
      pendingMigrations = files;
      return { isValid: true, pendingMigrations };
    }

    // Get migrations from database
    const dbResult = await pool.query('SELECT name FROM pgmigrations');
    const dbNames = new Set(dbResult.rows.map(r => r.name));
    const fileNamesWithoutExt = files.map(f => f.replace(/\.sql$/, ''));

    // Find pending migrations (files that exist but aren't in database - this is NORMAL)
    pendingMigrations = files.filter(file => {
      const nameWithoutExt = file.replace(/\.sql$/, '');
      return !dbNames.has(nameWithoutExt);
    });

    // Check for REAL mismatches (database records without corresponding files - this is a PROBLEM)
    const onlyInDb = [...dbNames].filter(name => !fileNamesWithoutExt.includes(name));

    // Only flag as invalid if there are database records without files (real mismatch)
    // New files that aren't in database are just pending migrations (normal)
    if (onlyInDb.length > 0) {
      console.log('⚠️  Migration mismatch detected!');
      console.log('\nMigrations in database but NOT in filesystem (this is a problem):');
      onlyInDb.forEach(name => console.log(`   - ${name}`));
      console.log('\n💡 Run "npm run migration:check" to diagnose and fix.');
      console.log('💡 This usually means a migration file was deleted or renamed.');
      isValid = false;
    }

    // Show pending migrations (new files to be run - this is normal)
    if (pendingMigrations.length > 0) {
      console.log(`\n📋 ${pendingMigrations.length} pending migration(s) will be run:`);
      pendingMigrations.forEach((file, index) => {
        console.log(`   ${index + 1}. ${file}`);
      });
    } else if (isValid) {
      console.log('\n✅ No pending migrations. Database is up to date!');
    }

    return { isValid, pendingMigrations };
  } catch (error) {
    console.error('Error checking migrations:', error.message);
    return { isValid: false, pendingMigrations: [] };
  } finally {
    await pool.end();
  }
}

async function runMigrations() {
  const { isValid, pendingMigrations } = await checkAndShowMigrations();
  
  if (!isValid && command === 'up') {
    console.log('\n❌ Cannot run migrations due to mismatches. Please fix them first.');
    console.log('💡 Run "npm run migration:list" to see what will run.');
    console.log('💡 Run "npm run migration:check" to diagnose issues.');
    process.exit(1);
  }

  if (pendingMigrations.length === 0 && command === 'up') {
    console.log('\n✅ No migrations to run. Exiting.');
    return;
  }

  try {
    console.log(`\n🔄 Running migrations: ${command.toUpperCase()}`);
    console.log('=====================================\n');

    let dbUrl =
      process.env.DB_URL ||
      `postgres://${process.env.PG_USERNAME}:${encodeURIComponent(
        process.env.PG_PASSWORD || '',
      )}@${process.env.PG_HOST}:${process.env.PG_PORT}/${process.env.PG_DATABASE}`;

    if (useSsl && !/[?&]sslmode=/i.test(dbUrl)) {
      dbUrl += (dbUrl.includes('?') ? '&' : '?') + 'sslmode=require';
    }

    process.env.DB_URL = dbUrl;

    const migrationCommand = command === 'down' 
      ? 'node-pg-migrate down'
      : 'node-pg-migrate up';

    execSync(
      `${migrationCommand} -m src/database/migrations --database-url-var DB_URL`,
      {
        stdio: 'inherit',
        cwd: path.join(__dirname, '..'),
      }
    );

    console.log('\n✅ Migrations completed successfully!');
  } catch (error) {
    console.error('\n❌ Error running migrations:', error.message);
    process.exit(1);
  }
}

runMigrations();
