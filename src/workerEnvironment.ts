type WorkerEnvironmentVariables = {
  sqsQueueURL: string;
};

export class WorkerEnvironment {
  private static _instance: WorkerEnvironmentVariables;
  private static _variableNames = ['sqsQueueURL'];

  public static getEnvironment() {
    if (!this._instance) {
      this._instance = this._variableNames.reduce((acc, key) => {
        const value = process.env[key];
        if (!value) {
          throw new Error(`Missing required environment variable ${key}`);
        }
        return {
          ...acc,
          [key]: process.env[key],
        };
      }, {} as WorkerEnvironmentVariables);
    }
    return this._instance;
  }
}
