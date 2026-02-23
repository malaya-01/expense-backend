/**
 * List pending migrations that will be run
 * Shows which migrations are in filesystem but not in database
 * 
 * Usage:
 *   node scripts/list-pending-migrations.js
 *   npm run migration:list
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT),
  user: process.env.PG_USERNAME,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
});

const migrationsDir = path.join(__dirname, '../src/database/migrations');

async function listPendingMigrations() {
  try {
    // Check if pgmigrations table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'pgmigrations'
      );
    `);

    if (!tableCheck.rows[0].exists) {
      console.log('\n📋 Pending Migrations:');
      console.log('=====================');
      console.log('ℹ️  pgmigrations table does not exist yet.');
      console.log('⚠️  ALL migration files will be run on first migration!\n');
      
      const files = fs.readdirSync(migrationsDir)
        .filter(file => file.endsWith('.sql'))
        .sort();
      
      if (files.length === 0) {
        console.log('No migration files found.');
      } else {
        console.log(`Found ${files.length} migration file(s) that will be run:\n`);
        files.forEach((file, index) => {
          console.log(`  ${index + 1}. ${file}`);
        });
      }
      return;
    }

    // Get migrations from database
    const dbResult = await pool.query('SELECT name FROM pgmigrations ORDER BY name');
    const dbNames = new Set(dbResult.rows.map(r => r.name));

    // Get migration files from filesystem
    const files = fs.readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort();
    
    const fileNamesWithoutExt = files.map(f => f.replace(/\.sql$/, ''));
    
    // Find pending migrations (in files but not in database)
    const pending = fileNamesWithoutExt.filter(name => !dbNames.has(name));
    const completed = fileNamesWithoutExt.filter(name => dbNames.has(name));

    console.log('\n📋 Migration Status:');
    console.log('===================\n');

    if (completed.length > 0) {
      console.log(`✅ Completed migrations (${completed.length}):`);
      completed.forEach((name, index) => {
        const file = files.find(f => f.replace(/\.sql$/, '') === name);
        console.log(`   ${index + 1}. ${file}`);
      });
      console.log('');
    }

    if (pending.length > 0) {
      console.log(`⏳ Pending migrations (${pending.length}) - These WILL be run:`);
      pending.forEach((name, index) => {
        const file = files.find(f => f.replace(/\.sql$/, '') === name);
        console.log(`   ${index + 1}. ${file}`);
      });
      console.log('');
    } else {
      console.log('✅ No pending migrations. Database is up to date!\n');
    }

    // Check for orphaned database records
    const onlyInDb = [...dbNames].filter(name => !fileNamesWithoutExt.includes(name));
    if (onlyInDb.length > 0) {
      console.log('⚠️  Warning: Migrations in database but NOT in filesystem:');
      onlyInDb.forEach(name => console.log(`   - ${name}`));
      console.log('   (These may cause issues - run "npm run migration:check" to fix)\n');
    }

  } catch (error) {
    console.error('Error listing migrations:', error.message);
    if (error.code === '42P01') {
      console.error('\n💡 The pgmigrations table does not exist. Run your first migration first.');
    }
  } finally {
    await pool.end();
  }
}

listPendingMigrations();
