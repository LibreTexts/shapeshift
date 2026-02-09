import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { JobQueueMessage, JobQueueMessageRawBody } from '../services/job';
import { Environment } from './environment';

export class QueueClient {
  private static _instance: SQSClient;

  public static getQueueUrl() {
    const isHighPriorityProcessor = Environment.getOptional('IS_HIGH_PRIORITY_PROCESSOR', 'false');
    return isHighPriorityProcessor === 'true'
      ? Environment.getRequired('SQS_HIGH_PRIORITY_QUEUE_URL')
      : Environment.getRequired('SQS_QUEUE_URL');
  }

  public static getClient() {
    if (!this._instance) {
      const config: any = {
        region: Environment.getRequired('AWS_REGION'),
      };
      
      // Extract endpoint from queue URL for local development
      const queueUrl = this.getQueueUrl();
      try {
        const url = new URL(queueUrl);
        // If it's not the standard AWS SQS endpoint, use it as a custom endpoint
        if (!url.hostname.endsWith('amazonaws.com')) {
          config.endpoint = `${url.protocol}//${url.host}`;
          config.forcePathStyle = true;
        }
      } catch (err) {
        // If URL parsing fails, proceed without custom endpoint
      }
      
      this._instance = new SQSClient(config);
    }
    return this._instance;
  }

  public async deleteJobMessage(receiptHandle: string) {
    const queueUrl = QueueClient.getQueueUrl();
    const client = QueueClient.getClient();
    await client.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  public async getNumberOfQueuedJobs() {
    const queueUrl = QueueClient.getQueueUrl();
    const client = QueueClient.getClient();
    const queueAttr = await client.send(
      new GetQueueAttributesCommand({
        AttributeNames: ['ApproximateNumberOfMessages'],
        QueueUrl: queueUrl,
      }),
    );
    const numMessagesRaw = queueAttr.Attributes?.ApproximateNumberOfMessages;
    if (!numMessagesRaw) {
      throw new Error('Did not retrieve number of messages from queue');
    }
    return Number.parseInt(numMessagesRaw);
  }

  public async lookForJobs(): Promise<JobQueueMessage[]> {
    const queueUrl = QueueClient.getQueueUrl();
    const client = QueueClient.getClient();
    const messages = await client.send(
      new ReceiveMessageCommand({
        MaxNumberOfMessages: 2,
        WaitTimeSeconds: 20,
        QueueUrl: queueUrl,
      }),
    );

    const isHighPriorityProcessor = Environment.getOptional('IS_HIGH_PRIORITY_PROCESSOR', 'false') === 'true';
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
      .filter((msg) => !(isHighPriorityProcessor && msg.isHighPriority));
  }

  public async sendJobMessage(msg: JobQueueMessageRawBody) {
    const client = QueueClient.getClient();
    await client.send(
      new SendMessageCommand({
        MessageBody: JSON.stringify(msg),
        ...(msg.isHighPriority && { MessageDeduplicationId: msg.jobId }),
        QueueUrl: msg.isHighPriority
          ? Environment.getRequired('SQS_HIGH_PRIORITY_QUEUE_URL')
          : Environment.getRequired('SQS_QUEUE_URL'),
      }),
    );
  }
}
