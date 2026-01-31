import 'dotenv/config';
import { JobService } from '../services/job';
import { QueueClient } from '../lib/queueClient';
import { connectDatabase } from '../model';
import { Environment } from '../lib/environment';

let isActiveWorker = true;

export async function runProcess() {
  Environment.load();
  await connectDatabase();
  const queueClient = new QueueClient();
  const jobModel = new JobService();
  while (isActiveWorker) {
    const jobs = await queueClient.lookForJobs();
    for (const job of jobs) {
      await jobModel.run(job);
    }
  }
}

process.on('SIGTERM', () => {
  console.log('Attempting graceful shutdown of Shapeshift worker...');
  isActiveWorker = false;
});

runProcess();
