import 'dotenv/config';
import { confirm } from '@inquirer/prompts';
import { exit } from 'process';
import { Environment } from './lib/environment';
import { sequelize } from './model';

async function runSync() {
  Environment.load();
  const env = Environment.getSystemEnvironment();
  const confirmation = await confirm({
    message: `Are you sure you want to sync the DB schema in the "${env}" environment?`,
  });
  if (!confirmation) {
    console.log('Sync canceled.');
    return;
  }
  await sequelize.sync({ alter: true });
}

runSync()
  .then(() => {
    console.log('Done!');
    exit(0);
  })
  .catch((err) => {
    console.error(err);
    exit(1);
  });
