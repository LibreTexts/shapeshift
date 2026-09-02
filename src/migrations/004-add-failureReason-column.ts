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

  await qi.addColumn('jobs', 'failureReason', { type: 'TEXT', allowNull: true, after: 'status' } as any);

  console.log('Added "failureReason" column after "status".');
}

run()
  .then(() => exit(0))
  .catch((err) => {
    console.error('Migration failed:', err);
    exit(1);
  });
