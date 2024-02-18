import { JobQueueMessage } from './types';
import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { runJob } from './job';
import { WorkerEnvironment } from './workerEnvironment';
import { QueueClient } from './queueClient';

let isActiveWorker = true;

async function lookForJobs(): Promise<JobQueueMessage[]> {
  const client = QueueClient.getClient();
  const messages = await client.send(
    new ReceiveMessageCommand({
      MaxNumberOfMessages: 2,
      QueueUrl: WorkerEnvironment.getEnvironment().sqsQueueURL,
      WaitTimeSeconds: 60,
    }),
  );
  return (messages.Messages ?? [])
    .map((msg) => ({
      jobId: msg.Body,
      receiptHandle: msg.ReceiptHandle,
    }))
    .filter((msg): msg is JobQueueMessage => !!msg.jobId && !!msg.receiptHandle);
}

export async function runProcess() {
  while (isActiveWorker) {
    const jobs = await lookForJobs();
    for (const job of jobs) {
      await runJob(job);
    }
  }
}

process.on('SIGTERM', () => {
  console.log('Attempting graceful shutdown of Shapeshift worker...');
  isActiveWorker = false;
});
