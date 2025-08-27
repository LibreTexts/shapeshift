import { ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { JobQueueMessage, JobQueueMessageRawBody } from '../services/job';
import { WorkerEnvironment } from './workerEnvironment';
import { getEnvironmentVariable } from './environment';

export class QueueClient {
  private static _instance: SQSClient;

  public static getClient() {
    if (!this._instance) {
      this._instance = new SQSClient();
    }
    return this._instance;
  }

  public async lookForJobs(): Promise<JobQueueMessage[]> {
    const client = QueueClient.getClient();
    const messages = await client.send(
      new ReceiveMessageCommand({
        MaxNumberOfMessages: 2,
        QueueUrl: WorkerEnvironment.getEnvironment().sqsQueueURL,
        WaitTimeSeconds: 60,
      }),
    );

    const isInterruptibleWorker = getEnvironmentVariable('IS_INTERRUPTIBLE_ENV', 'true') === 'true';
    return (messages.Messages ?? [])
      .map((msg) => {
        const body = JSON.parse(msg.Body!) as JobQueueMessageRawBody;
        return {
          jobId: body.jobId,
          isHighPriority: body.isHighPriority ?? false,
          receiptHandle: msg.ReceiptHandle,
        };
      })
      .filter((msg): msg is JobQueueMessage => !!msg.jobId && !!msg.receiptHandle)
      .filter((msg) => !(isInterruptibleWorker && msg.isHighPriority));
  }
}
