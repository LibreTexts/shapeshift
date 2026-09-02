import 'dotenv/config';
import { confirm } from '@inquirer/prompts';
import { Environment } from '../lib/environment';
import { sequelize } from '../model';
import { exit } from 'process';

const MIGRATION_NAME = '004-add-failureReason-column';

async function run() {
  Environment.load();
  const env = Environment.getSystemEnvironment();
  const confirmation = await confirm({
    message: `Run migration "${MIGRATION_NAME}" in the "${env}" environment?`,
  });
  if (!confirmation) {
    console.log('Migration canceled.');
    return;
  }

  const qi = sequelize.getQueryInterface();

  // Check if column already exists
  const columns = await qi.describeTable('jobs');
  if ('failureReason' in columns) {
    console.log('Column "failureReason" already exists — skipping.');
    return;
  }

  // No `after`, for the reason 003 spells out: positional ADD COLUMN is INSTANT only on MySQL
  // 8.0.29+, and below that it rebuilds the whole `jobs` table under an exclusive metadata lock.
  // Appending is INSTANT from 8.0.12, and physical column order buys nothing here.
  await qi.addColumn('jobs', 'failureReason', { type: 'TEXT', allowNull: true } as any);

  console.log('Added "failureReason" column.');
}

run()
  .then(() => exit(0))
  .catch((err) => {
    console.error('Migration failed:', err);
    exit(1);
  });
