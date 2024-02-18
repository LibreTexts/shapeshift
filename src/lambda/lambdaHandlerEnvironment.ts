type LambdaHandlerEnvironmentVariables = {
  sqsHighPriorityQueueURL: string;
  sqsQueueURL: string;
};

export class LambdaHandlerEnvironment {
  private static _instance: LambdaHandlerEnvironmentVariables;
  private static _variableNames = ['sqsHighPriorityQueueURL', 'sqsQueueURL'];

  public static getEnvironment() {
    if (!this._instance) {
      this._variableNames.forEach((key) => {
        if (!process.env[key]) {
          throw new Error(`Missing required environment variable ${key}`);
        }
      });
    }
    return this._instance;
  }
}
