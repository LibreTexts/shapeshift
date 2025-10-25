const PROCESSOR_WORKER_ENVIRONMENT_VARIABLE_NAMES = [
  'AWS_ACCESS_KEY_ID',
  'AWS_REGION',
  'AWS_SECRET_ACCESS_KEY',
  'BUCKET',
  'SQS_QUEUE_URL',
] as const;
// Environment variables that are REQUIRED for processor workers.
type ProcessorWorkerEnvironmentVariables = Record<(typeof PROCESSOR_WORKER_ENVIRONMENT_VARIABLE_NAMES)[number], string>;
export class ProcessorWorkerEnvironment {
  private static _instance: ProcessorWorkerEnvironmentVariables;

  /**
   * Returns environment variables that are REQUIRED for processor workers.
   */
  public static getEnvironment() {
    if (!this._instance) this._instance = {} as ProcessorWorkerEnvironmentVariables;
    if (Object.keys(this._instance).length === 0) {
      for (const varName of PROCESSOR_WORKER_ENVIRONMENT_VARIABLE_NAMES) {
        const v = process.env[varName];
        if (!v) throw new Error(`Missing required environment variable ${varName}`);
        this._instance[varName] = v;
      }
    }
    return this._instance;
  }
}
