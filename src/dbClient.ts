import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

export class DBClient {
  private static _instance: DynamoDBClient;

  public static getClient() {
    if (!this._instance) {
      this._instance = new DynamoDBClient();
    }
    return this._instance;
  }
}
