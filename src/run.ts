import 'dotenv/config';
import { exit } from 'process';
import { hideBin } from 'yargs/helpers';
import { JobController } from './controllers/job';
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
  const jobController = new JobController();
  const createRes = await jobController.create({
    body: JSON.stringify({
      highPriority: false,
      url: bookURL,
    }),
    headers: { origin: 'localhost' },
    requestContext: {
      // @ts-expect-error don't need to implement all members here
      identity: {
        sourceIp: 'localhost',
      },
    },
  });
  if (createRes?.statusCode !== '200') {
    yargs.exit(1, new Error(createRes?.body ?? 'Unexpected response from create request'));
  }

  const jobModel = new JobService();
  const createData = JSON.parse(createRes.body)?.data;
  await jobModel.run({
    jobId: createData.id,
    isHighPriority: false,
    receiptHandle: createData.id,
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
