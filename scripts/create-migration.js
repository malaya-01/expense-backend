/**
 * Wrapper script for creating migrations with node-pg-migrate
 * Ensures consistent naming and handles .sql extension properly
 * 
 * Usage:
 *   node scripts/create-migration.js <migration-name>
 *   npm run migration:create <migration-name>
 */

const { execSync } = require('child_process');
const path = require('path');

const migrationName = process.argv[2];

if (!migrationName) {
  console.error('❌ Error: Migration name is required');
  console.log('\nUsage:');
  console.log('  npm run migration:create <migration-name>');
  console.log('  node scripts/create-migration.js <migration-name>');
  console.log('\nExample:');
  console.log('  npm run migration:create add-user-roles');
  process.exit(1);
}

// Validate migration name (should be lowercase, use hyphens, no spaces)
if (!/^[a-z0-9-]+$/.test(migrationName)) {
  console.error('❌ Error: Migration name should only contain lowercase letters, numbers, and hyphens');
  console.log('Example: add-user-roles, update-expense-table, create-categories');
  process.exit(1);
}

try {
  console.log(`\n📝 Creating migration: ${migrationName}`);
  console.log('=====================================\n');

  // Create migration using node-pg-migrate
  // The -j sql flag creates SQL files, and node-pg-migrate automatically
  // stores the name without .sql extension in the database
  const command = `node-pg-migrate create ${migrationName} -j sql -m src/database/migrations`;
  
  execSync(command, {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
  });

  console.log('\n✅ Migration created successfully!');
  console.log('\n💡 Next steps:');
  console.log('   1. Edit the migration file in src/database/migrations/');
  console.log('   2. Add your SQL statements between -- Up Migration and -- Down Migration');
  console.log('   3. Run: npm run migration:up');
  
} catch (error) {
  console.error('\n❌ Error creating migration:', error.message);
  process.exit(1);
}
