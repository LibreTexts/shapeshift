import { SSMClient } from '@aws-sdk/client-ssm';

export type CXOneFetchPageParams = {
  subdomain: string;
  options?: Record<string, string>;
  query?: Record<string, string>;
  silentFail?: boolean;
  path: string | number;
  api: string;
};

export type LibrariesSSMClient = {
  apiUsername: string;
  libTokenPairPath: string;
  ssm: SSMClient;
};

export type LibraryKeyPair = {
  key: string;
  secret: string;
};

export type LibraryAPIRequestHeaders = {
  'X-Deki-Token': string;
  'X-Requested-With': string;
};
