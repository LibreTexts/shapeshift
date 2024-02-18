import { SQSClient } from '@aws-sdk/client-sqs';

export class QueueClient {
  private static _instance: SQSClient;

  public static getClient() {
    if (!this._instance) {
      this._instance = new SQSClient();
    }
    return this._instance;
  }
}
