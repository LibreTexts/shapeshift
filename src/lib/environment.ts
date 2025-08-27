export type SystemEnvironment = 'PRODUCTION' | 'STAGING' | 'DEVELOPMENT';

export function getEnvironment() {
  return getEnvironmentVariable('NODE_ENV', 'DEVELOPMENT').toUpperCase() as SystemEnvironment;
}

export function getEnvironmentVariable<T>(varName: string, defaultValue?: T) {
  if (process.env[varName]) return process.env[varName] as string;
  if (defaultValue) return defaultValue;
  throw new Error(`Missing environment variable "${varName}"! No default value configured.`);
}
