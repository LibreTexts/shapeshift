import 'dotenv/config';
import { JobService } from '../services/job';
import { QueueClient } from '../lib/queueClient';
import { connectDatabase } from '../model';
import { Environment } from '../lib/environment';
import { shutdownMathJax } from '../util/mathjax';
import { log as logService } from '../lib/log';

const logger = logService.child().withContext({ logSource: 'Processor' });

let isActiveWorker = true;

function logMemoryUsage(phase: string, jobId?: string) {
  const usage = process.memoryUsage();
  const metadata = {
    phase,
    ...(jobId && { jobId }),
    rssMB: Math.round(usage.rss / 1024 / 1024),
    heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024),
  };
  logger.withMetadata(metadata).info('Memory usage report');
}

export async function runProcess() {
  Environment.load();
  await connectDatabase();
  logger.info('Shapeshift processor worker started.');
  const queueClient = new QueueClient();
  const jobModel = new JobService();
  const memoryLogInterval = setInterval(() => logMemoryUsage('periodic'), 30_000);
  while (isActiveWorker) {
    const jobs = await queueClient.lookForJobs();
    for (const job of jobs) {
      if (!isActiveWorker) break;
      // Delete the message immediately to prevent multiple workers from processing the same job
      // and/or if the job fails we don't want it to be retried indefinitely.
      await queueClient.deleteJobMessage(job.receiptHandle);
      logMemoryUsage('job-start', job.jobId);
      await jobModel.run(job);
      logMemoryUsage('job-end', job.jobId);
    }
  }
  clearInterval(memoryLogInterval);
  await shutdownMathJax();
  logger.info('Shapeshift processor worker shut down gracefully.');
  process.exit(0);
}

function shutdown() {
  if (!isActiveWorker) return;
  logger.info('Shutdown signal received, finishing current job...');
  isActiveWorker = false;
}

// Register shutdown signal listeners
const signals = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
Object.keys(signals).forEach((signal) => process.on(signal, shutdown));

runProcess();
