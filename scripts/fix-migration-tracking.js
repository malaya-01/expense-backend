/**
 * Script to fix migration tracking issues with node-pg-migrate
 * 
 * This script helps diagnose and fix cases where migration files
 * have been renamed but the database still tracks the old filename.
 * 
 * Usage:
 *   node scripts/fix-migration-tracking.js check
 *   node scripts/fix-migration-tracking.js fix <old-name> <new-name>
 *   node scripts/fix-migration-tracking.js delete <migration-name>
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

async function checkMigrations() {
  try {
    // Get migrations from database
    const dbResult = await pool.query('SELECT * FROM pgmigrations ORDER BY run_on');
    console.log('\n📊 Migrations recorded in database:');
    console.log('=====================================');
    if (dbResult.rows.length === 0) {
      console.log('No migrations found in database.');
    } else {
      dbResult.rows.forEach((row, index) => {
        console.log(`${index + 1}. ${row.name} (run on: ${row.run_on})`);
      });
    }

    // Get migration files from filesystem
    const files = fs.readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort();
    
    console.log('\n📁 Migration files in filesystem:');
    console.log('=================================');
    if (files.length === 0) {
      console.log('No migration files found.');
    } else {
      files.forEach((file, index) => {
        console.log(`${index + 1}. ${file}`);
      });
    }

    // Compare (node-pg-migrate stores names without .sql extension)
    console.log('\n🔍 Comparison:');
    console.log('==============');
    const dbNames = new Set(dbResult.rows.map(r => r.name));
    // Remove .sql extension from filenames for comparison
    const fileNamesWithoutExt = new Set(files.map(f => f.replace(/\.sql$/, '')));
    const fileNames = new Set(files);

    // Compare without extension
    const onlyInDb = [...dbNames].filter(name => !fileNamesWithoutExt.has(name));
    const onlyInFiles = [...fileNames].filter(file => {
      const nameWithoutExt = file.replace(/\.sql$/, '');
      return !dbNames.has(nameWithoutExt);
    });

    if (onlyInDb.length > 0) {
      console.log('\n⚠️  Migrations in database but NOT in filesystem:');
      onlyInDb.forEach(name => console.log(`   - ${name}`));
    }

    if (onlyInFiles.length > 0) {
      console.log('\n⚠️  Migration files NOT recorded in database:');
      onlyInFiles.forEach(name => console.log(`   - ${name}`));
    }

    if (onlyInDb.length === 0 && onlyInFiles.length === 0) {
      console.log('✅ All migrations are in sync!');
    }

  } catch (error) {
    console.error('Error checking migrations:', error.message);
    if (error.code === '42P01') {
      console.error('\n💡 The pgmigrations table does not exist. Run your first migration first.');
    }
  } finally {
    await pool.end();
  }
}

async function fixMigration(oldName, newName) {
  try {
    const result = await pool.query(
      'UPDATE pgmigrations SET name = $1 WHERE name = $2 RETURNING *',
      [newName, oldName]
    );

    if (result.rows.length > 0) {
      console.log(`✅ Updated migration record: "${oldName}" → "${newName}"`);
    } else {
      console.log(`❌ No migration found with name: "${oldName}"`);
    }
  } catch (error) {
    console.error('Error fixing migration:', error.message);
  } finally {
    await pool.end();
  }
}

async function deleteMigration(migrationName) {
  try {
    const result = await pool.query(
      'DELETE FROM pgmigrations WHERE name = $1 RETURNING *',
      [migrationName]
    );

    if (result.rows.length > 0) {
      console.log(`✅ Deleted migration record: "${migrationName}"`);
      console.log('⚠️  Note: You may need to re-run this migration if it hasn\'t been applied yet.');
    } else {
      console.log(`❌ No migration found with name: "${migrationName}"`);
    }
  } catch (error) {
    console.error('Error deleting migration:', error.message);
  } finally {
    await pool.end();
  }
}

// Main
const command = process.argv[2];

if (command === 'check') {
  checkMigrations();
} else if (command === 'fix') {
  const oldName = process.argv[3];
  const newName = process.argv[4];
  if (!oldName || !newName) {
    console.error('Usage: node scripts/fix-migration-tracking.js fix <old-name> <new-name>');
    process.exit(1);
  }
  fixMigration(oldName, newName);
} else if (command === 'delete') {
  const migrationName = process.argv[3];
  if (!migrationName) {
    console.error('Usage: node scripts/fix-migration-tracking.js delete <migration-name>');
    process.exit(1);
  }
  deleteMigration(migrationName);
} else {
  console.log('Usage:');
  console.log('  node scripts/fix-migration-tracking.js check');
  console.log('  node scripts/fix-migration-tracking.js fix <old-name> <new-name>');
  console.log('  node scripts/fix-migration-tracking.js delete <migration-name>');
  process.exit(1);
}
