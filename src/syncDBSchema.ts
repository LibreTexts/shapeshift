import 'dotenv/config';
import { confirm } from '@inquirer/prompts';
import { connectDatabase } from './model';
import { exit } from 'process';
import { getEnvironment } from './lib/environment';

async function runSync() {
  const env = getEnvironment();
  const confirmation = await confirm({
    message: `Are you sure you want to sync the DB schema in the "${env}" environment?`,
  });
  if (!confirmation) {
    console.log('Sync canceled.');
    return;
  }
  await connectDatabase(true);
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
