const API_WORKER_ENVIRONMENT_VARIABLE_NAMES = [
  'CLOUDFRONT_DISTRIBUTION_DOMAIN',
  'CLOUDFRONT_KEY_PAIR_ID',
  'CLOUDFRONT_PRIVATE_KEY',
  'SQS_HIGH_PRIORITY_QUEUE_URL',
  'SQS_QUEUE_URL',
] as const;
// Environment variables that are REQUIRED for API workers.
type APIWorkerEnvironmentVariables = Record<(typeof API_WORKER_ENVIRONMENT_VARIABLE_NAMES)[number], string>;
export class APIWorkerEnvironment {
  private static _instance: APIWorkerEnvironmentVariables;

  /**
   * Returns environment variables that are REQUIRED for API workers.
   */
  public static getEnvironment() {
    if (!this._instance) this._instance = {} as APIWorkerEnvironmentVariables;
    if (Object.keys(this._instance).length === 0) {
      for (const varName of API_WORKER_ENVIRONMENT_VARIABLE_NAMES) {
        const v = process.env[varName];
        if (!v) throw new Error(`Missing required environment variable ${varName}`);
        this._instance[varName] = v;
      }
    }
    return this._instance;
  }
}
