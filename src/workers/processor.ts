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
      if (!isActiveWorker) break;
      // Delete the message immediately to prevent multiple workers from processing the same job
      // and/or if the job fails we don't want it to be retried indefinitely.
      await queueClient.deleteJobMessage(job.receiptHandle);
      await jobModel.run(job);
    }
  }
  console.log('Shapeshift processor worker shut down gracefully.');
}

function shutdown() {
  console.log('Shutdown signal received, finishing current job...');
  isActiveWorker = false;
}

// Register shutdown signal listeners
const signals = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
Object.keys(signals).forEach((signal) => process.on(signal, shutdown));

runProcess();
