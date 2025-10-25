import 'dotenv/config';
import { exit } from 'process';
import { hideBin } from 'yargs/helpers';
import { JobService } from './services/job';
import yargs from 'yargs';

const argv = yargs(hideBin(process.argv))
  .options({
    bookURL: {
      type: 'string',
      demandOption: true,
    },
  })
  .parseSync();
if (!argv.bookURL) {
  yargs.exit(1, new Error('No book URL provided.'));
}

async function runJob(bookURL: string) {
  const jobModel = new JobService();
  const jobId = await jobModel.create({
    isHighPriority: false,
    requesterIp: 'localhost',
    url: bookURL,
  });
  await jobModel.run({
    jobId: jobId,
    isHighPriority: false,
    receiptHandle: jobId,
  });
}

runJob(argv.bookURL)
  .then(() => {
    console.log('Done!');
    exit(0);
  })
  .catch((err) => {
    console.error(err);
    exit(1);
  });
