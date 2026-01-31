import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { createHmac } from 'crypto';
import axios, { AxiosResponse } from 'axios';
import { getErrorMessage } from '../helpers';
import Expert from '@libretexts/cxone-expert-node';
import Auth from '@libretexts/cxone-expert-node/dist/modules/auth';
import { ProcessorWorkerEnvironment } from '../lib/processorWorkerEnvironment';

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
  private expertAuthInstance: Auth | null = null;
  private expertClient: Expert | null = null;
  private ssmClient: LibrariesSSMClient | null = null;
  private requestHeaders: LibraryAPIRequestHeaders | null = null;
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
    this.requestHeaders = this._generateAPIRequestHeaders();
    this.expertClient = new Expert(`https://${this.lib}.libretexts.org`);
  }

  public get api() {
    if (!this.expertClient) {
      this.expertClient = new Expert(`https://${this.lib}.libretexts.org`);
    }
    return this.expertClient;
  }

  public get auth() {
    if (!this.keyPair || !this.user || !this.expertClient) {
      throw new Error(`[${this.logName}] Cannot get auth instance: missing KeyPair, User, or Client instance!`);
    }
    this.expertAuthInstance = this.expertClient.auth.ServerToken({
      key: this.keyPair?.key ?? 'INVALID',
      secret: this.keyPair?.secret ?? 'INVALID',
      user: this.user,
    });
    return this.expertAuthInstance.getHeader();
  }

  public get authToken(): string {
    if (!this.keyPair || !this.user || !this.expertClient) {
      throw new Error(`[${this.logName}] Cannot get token: missing KeyPair, User, or Client instance!`);
    }
    this.expertAuthInstance = this.expertClient.auth.ServerToken({
      key: this.keyPair?.key ?? 'INVALID',
      secret: this.keyPair?.secret ?? 'INVALID',
      user: this.user,
    });
    return this.expertAuthInstance.getToken()!;
  }

  /**
   * Generates the set of request headers required for interacting with a library's API,
   * including the API token.
   */
  private _generateAPIRequestHeaders(): LibraryAPIRequestHeaders | null {
    try {
      if (!this.ssmClient || !this.keyPair) {
        throw new Error('Error generating libraries client.');
      }

      const epoch = Math.floor(Date.now() / 1000);
      const hmac = createHmac('sha256', this.keyPair.secret);
      hmac.update(`${this.keyPair.key}${epoch}=${this.ssmClient.apiUsername}`);
      return {
        'X-Deki-Token': `${this.keyPair.key}_${epoch}_=${this.ssmClient.apiUsername}_${hmac.digest('hex')}`,
        'X-Requested-With': 'XMLHttpRequest',
      };
    } catch (err) {
      console.error('Error generating API request headers.');
      return null;
    }
  }

  private _generateLibrariesSSMClient(): LibrariesSSMClient | null {
    try {
      const libTokenPairPath = process.env.AWS_SSM_LIB_TOKEN_PAIR_PATH || '/libkeys/production';
      const apiUsername = process.env.LIBRARIES_API_USERNAME || 'LibreBot';

      const workerEnvironment = ProcessorWorkerEnvironment.getEnvironment();
      const ssm = new SSMClient({ region: workerEnvironment.AWS_REGION });

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

  /**
   * axios wrapper function that automatically uses Mindtouch browser or server API tokens
   * @param {string|number} path - the path or pageID of the target page. Can also instead take a full arbitrary API url.
   * @param {string} api - the /pages {@link https://success.mindtouch.com/Integrations/API/API_Calls/pages|sub-endpoint} that you are calling
   * @param {string} subdomain - subdomain that the target page belongs to
   * @param {Object} [options={}] - optional options that will be passed to axios
   * @param {Object} [query={}] - optional query parameters that will be appended to the request url
   * @param {boolean} [silentFail=false] - if true, will not throw an error if the fetch fails
   */
  public async fetch(params: CXOneFetchPageParams): Promise<AxiosResponse> {
    try {
      const { subdomain, options, query, silentFail } = params;

      if (!this.requestHeaders) {
        throw new Error('Error generating API request headers.');
      }
      const finalOptions = this._optionsMerge(this.requestHeaders, options);

      const { path, api } = params;
      const isNumber = !isNaN(Number(path));
      const queryIsFirst = api.includes('?') ? false : true;
      const url = `https://${subdomain}.libretexts.org/@api/deki/pages/${
        isNumber ? '' : '='
      }${encodeURIComponent(encodeURIComponent(path))}/${api}${this._parseQuery(query, queryIsFirst)}`;

      const res = await axios(url, finalOptions);
      if (!res.data && !silentFail) {
        throw new Error(`Error fetching page from ${subdomain}.`);
      }

      return res;
    } catch (err: unknown) {
      throw new Error(`Request failed: ${getErrorMessage(err)}`);
    }
  }

  /**
   *
   * @param {object} query - Object containing query parameters
   * @param {boolean} first - Whether or not this is the first query parameter (defaults to false)
   * @returns {string} - An encoded query string (e.g. '&key=value&key2=value2' or '?key=value&key2=value2' if first is true)
   */
  private _parseQuery(query?: Record<string, string>, first = false) {
    if (!query) return '';

    const searchParams = new URLSearchParams();
    for (const key in query) {
      searchParams.append(key, query[key]);
    }
    return `${first ? '?' : '&'}${searchParams.toString()}`;
  }

  private _optionsMerge(headers: Record<string, string>, options?: Record<string, string | object>) {
    if (!options) {
      return { headers };
    }
    if (!options.headers) {
      options.headers = Object.assign(headers, options.headers);
    } else {
      options.headers = headers;
    }
    return options;
  }
}
