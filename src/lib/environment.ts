export type SystemEnvironment = 'PRODUCTION' | 'STAGING' | 'DEVELOPMENT';

const REQUIRED_ENV = [
  'AWS_REGION',
  'BUCKET',
  'CLOUDWATCH_BPI_METRIC_NAME',
  'CLOUDWATCH_BPI_METRIC_NAMESPACE',
  'CLOUDFRONT_DISTRIBUTION_DOMAIN',
  'CLOUDFRONT_KEY_PAIR_ID',
  'CLOUDFRONT_PRIVATE_KEY',
  'ECS_CLUSTER_NAME',
  'ECS_SERVICE_NAME',
  'SQS_HIGH_PRIORITY_QUEUE_URL',
  'SQS_QUEUE_URL',
] as const;

const OPTIONAL_ENV = [
  'CXONE_RATE_LIMITER_DURATION',
  'CXONE_RATE_LIMITER_POINTS',
  'DB',
  'DB_HOST',
  'DB_HOST_READ',
  'DB_PASSWORD',
  'DB_PASSWORD_READ',
  'DB_PORT',
  'DB_PORT_READ',
  'DB_USER',
  'DB_USER_READ',
  'IS_HIGH_PRIORITY_PROCESSOR',
  'PORT',
  'TMP_OUT_DIR',
  'USE_LOCAL_STORAGE',
] as const;

type RequiredEnvKey = (typeof REQUIRED_ENV)[number];
type OptionalEnvKey = (typeof OPTIONAL_ENV)[number];

export type EnvironmentVariables = Record<RequiredEnvKey, string> &
  Partial<Record<OptionalEnvKey, string>> & {
    NODE_ENV: SystemEnvironment;
  };

export class Environment {
  private static _instance: EnvironmentVariables | null = null;

  public static getOptional<K extends OptionalEnvKey>(name: K): string | undefined;
  public static getOptional<K extends OptionalEnvKey>(name: K, defaultValue: string): string;
  public static getOptional<K extends OptionalEnvKey>(name: K, defaultValue?: string) {
    return this.instance[name] ?? defaultValue;
  }

  private static getRaw(name: string): string | undefined {
    const v = process.env[name];
    return v === undefined || v === '' ? undefined : v;
  }

  public static getRequired<K extends RequiredEnvKey>(name: K): string {
    return this.instance[name];
  }

  public static getSystemEnvironment(): SystemEnvironment {
    return this.instance.NODE_ENV;
  }

  private static get instance(): EnvironmentVariables {
    if (!this._instance) {
      this._instance = this.load();
    }
    return this._instance;
  }

  public static load(): EnvironmentVariables {
    const env = {} as EnvironmentVariables;

    const nodeEnvRaw = process.env.NODE_ENV;
    if (nodeEnvRaw) {
      env.NODE_ENV = nodeEnvRaw as SystemEnvironment;
    } else {
      throw new Error('Missing "NODE_ENV" variable!');
    }

    for (const k of REQUIRED_ENV) {
      const v = process.env[k];
      if (!v) throw new Error(`Missing required environment variable ${k}`);
      env[k] = v;
    }

    for (const k of OPTIONAL_ENV) {
      const v = process.env[k];
      if (v != null && v !== '') env[k] = v;
    }

    return env;
  }
}
