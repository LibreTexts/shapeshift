import 'dotenv/config';
import { confirm } from '@inquirer/prompts';
import { Environment } from '../lib/environment';
import { sequelize } from '../model';
import { exit } from 'process';

const MIGRATION_NAME = '002-add-createdAt-index';

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

  // Check if index already exists
  const INDEX_NAME = 'jobs_createdAt';
  const indices = (await qi.showIndex('jobs')) as Record<string, any>[];
  const existingIndex = indices.find((i) => i.name === INDEX_NAME);
  if (existingIndex) {
    console.log(`Index "${INDEX_NAME}" already exists — skipping.`);
    return;
  }

  await qi.addIndex('jobs', { fields: [{ name: 'createdAt', order: 'DESC' }], name: INDEX_NAME });

  console.log(`Added "${INDEX_NAME}" index.`);
}

run()
  .then(() => exit(0))
  .catch((err) => {
    console.error('Migration failed:', err);
    exit(1);
  });
