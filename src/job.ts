import { DBClient } from './dbClient';
import { DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { JobQueueMessage, JobStatus } from './types';
import { WorkerEnvironment } from './workerEnvironment';
import { UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { QueueClient } from './queueClient';

async function setJobStatus(jobId: string, newStatus: JobStatus) {
  const dbClient = DBClient.getClient();
  await dbClient.send(
    new UpdateItemCommand({
      Key: {
        jobId: {
          S: jobId,
        },
      },
      TableName: 'jobs',
      UpdateExpression: `SET jobStatus = '${newStatus}'`,
    }),
  );
}

async function finishJob(job: JobQueueMessage) {
  const client = QueueClient.getClient();
  await client.send(
    new DeleteMessageCommand({
      QueueUrl: WorkerEnvironment.getEnvironment().sqsQueueURL,
      ReceiptHandle: job.receiptHandle,
    }),
  );
  await setJobStatus(job.jobId, 'finished');
}

export async function runJob(job: JobQueueMessage) {
  await setJobStatus(job.jobId, 'inprogress');
  // do shapeshift...
  await finishJob(job);
}
