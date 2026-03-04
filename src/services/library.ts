import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import Expert from '@libretexts/cxone-expert-node';
import { Environment } from '../lib/environment';
import { sleep } from '../helpers';

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

type ConstructorParams = {
  lib: string;
  user?: string;
};

/**
 * Class for interacting with the LibreTexts libraries hosted on Mindtouch.
 * NOTE: init() must be called immediately after instantiation, otherwise all fetch calls will fail.
 * @param {string} lib - The subdomain of the library to interact with.
 */
export class LibraryService {
  private expertClient: Expert | null = null;
  private ssmClient: LibrariesSSMClient | null = null;
  private keyPair: LibraryKeyPair | null = null;
  private readonly lib: string;
  private readonly logName = 'LibraryClient';
  private readonly user: string;

  constructor(params: ConstructorParams) {
    this.lib = params.lib;
    this.user = params.user ?? 'LibreBot';
  }

  /**
   * Initializes the LibrariesClient instance.
   */
  public async init() {
    this.ssmClient = this._generateLibrariesSSMClient();
    this.keyPair = await this._getLibraryTokenPair(this.lib);
    this.expertClient = new Expert({
      auth: {
        type: 'server',
        params: {
          key: this.keyPair?.key ?? 'INVALID',
          secret: this.keyPair?.secret ?? 'INVALID',
          user: this.user,
        },
      },
      tld: `${this.lib}.libretexts.org`,
      debug: false, // this is very verbose, so only turn on when needed
    });
  }

  private _ensureInitialized() {
    if (!this.ssmClient || !this.keyPair || !this.expertClient) {
      throw new Error(`[${this.logName}] Client not properly initialized. Please call init() before using the client.`);
    }
  }

  public get api() {
    this._ensureInitialized();
    return this.expertClient!;
  }

  private _generateLibrariesSSMClient(): LibrariesSSMClient | null {
    try {
      const libTokenPairPath = process.env.AWS_SSM_LIB_TOKEN_PAIR_PATH || '/libkeys/production';
      const apiUsername = process.env.LIBRARIES_API_USERNAME || 'LibreBot';

      const ssm = new SSMClient({
        ...(Environment.getSystemEnvironment() === 'DEVELOPMENT' && {
          endpoint: `http://${Environment.getOptional('LOCALSTACK_HOST', 'localhost')}:${Environment.getOptional('LOCALSTACK_PORT', '4566')}`,
        }),
        region: Environment.getRequired('AWS_REGION'),
      });

      return {
        apiUsername,
        libTokenPairPath,
        ssm,
      };
    } catch (err) {
      console.error('Error generating libraries client.');
      return null;
    }
  }

  /**
   * Retrieves the token pair requried to interact with a library's API.
   */
  private async _getLibraryTokenPair(lib: string): Promise<LibraryKeyPair | null> {
    try {
      if (!this.ssmClient) throw new Error('Error retrieving library token pair. Lib: ' + lib);
      const basePath = this.ssmClient.libTokenPairPath.endsWith('/')
        ? this.ssmClient.libTokenPairPath
        : `${this.ssmClient.libTokenPairPath}/`;
      const pairResponse = await this.ssmClient.ssm.send(
        new GetParametersByPathCommand({
          Path: `${basePath}${lib}`,
          MaxResults: 10,
          Recursive: true,
          WithDecryption: true,
        }),
      );

      if (pairResponse.$metadata.httpStatusCode !== 200) {
        console.error('Error retrieving library token pair. Lib: ' + lib);
        console.error('Metadata: ');
        console.error(pairResponse.$metadata);
        throw new Error('Error retrieving library token pair.');
      }
      if (!pairResponse.Parameters) {
        console.error('No data returned from token pair retrieval. Lib: ' + lib);
        throw new Error('Error retrieving library token pair.');
      }

      const libKey = pairResponse.Parameters.find((p) => p.Name?.includes(`${lib}/key`));
      const libSec = pairResponse.Parameters.find((p) => p.Name?.includes(`${lib}/secret`));
      if (!libKey?.Value || !libSec?.Value) {
        console.error('Key param not found in token pair retrieval. Lib: ' + lib);
        throw new Error('Error retrieving library token pair.');
      }

      return {
        key: libKey.Value,
        secret: libSec.Value,
      };
    } catch (err) {
      console.error('Error retrieving library token pair. Lib: ' + lib, err);
      return null;
    }
  }
}
