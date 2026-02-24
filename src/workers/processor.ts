import 'dotenv/config';
import { JobService } from '../services/job';
import { QueueClient } from '../lib/queueClient';
import { connectDatabase } from '../model';
import { Environment } from '../lib/environment';

let isActiveWorker = true;

export async function runProcess() {
  Environment.load();
  await connectDatabase();
  console.log(`Shapeshift processor worker started.`);
  const queueClient = new QueueClient();
  const jobModel = new JobService();
  while (isActiveWorker) {
    const jobs = await queueClient.lookForJobs();
    for (const job of jobs) {
      // Delete the message immediately to prevent multiple workers from processing the same job
      // and/or if the job fails we don't want it to be retried indefinitely.
      await queueClient.deleteJobMessage(job.receiptHandle);
      await jobModel.run(job);
    }
  }
}

process.on('SIGTERM', () => {
  console.log('Attempting graceful shutdown of Shapeshift worker...');
  isActiveWorker = false;
});

runProcess();
