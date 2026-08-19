import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { log as logService } from './log';
import { LogLayer } from 'loglayer';
import { Readable } from 'node:stream';
import { Environment } from './environment';

/**
 * Applied to every uploaded artifact. Object keys are stable across recompiles, so a long
 * browser `max-age` would pin clients to a previous build; the download API defeats that by
 * appending a content-version query param to the URL it redirects to (see DownloadController).
 * These values only bound staleness for clients that hit the storage URL directly.
 */
const ARTIFACT_CACHE_CONTROL = 'public, max-age=3600, s-maxage=60';

export interface ObjectMetadata {
  etag: string | null;
  lastModified: Date | null;
}

export class StorageService {
  private readonly bucket: string;
  private readonly client: S3Client;
  private readonly logger: LogLayer;
  private readonly logName = 'StorageService';

  constructor() {
    this.bucket = Environment.getRequired('BUCKET');
    this.logger = logService.child().withContext({ logSource: this.logName });
    this.client = new S3Client({
      ...(Environment.getSystemEnvironment() === 'DEVELOPMENT' && {
        endpoint: `http://${Environment.getOptional('LOCALSTACK_HOST', 'localhost')}:${Environment.getOptional('LOCALSTACK_PORT', '4566')}`,
        forcePathStyle: true,
      }),
      region: Environment.getRequired('AWS_REGION'),
    });
  }

  public async uploadFile({ contentType, data, key }: { contentType: string; data: Buffer; key: string }) {
    try {
      const uploader = new Upload({
        client: this.client,
        queueSize: 4,
        leavePartsOnError: false,
        params: {
          Bucket: this.bucket,
          Body: data,
          ContentType: contentType,
          Key: key,
          CacheControl: ARTIFACT_CACHE_CONTROL,
        },
      });
      await uploader.done();
    } catch (err) {
      const errString = (err as Error).message;
      this.logger.error(errString);
      // Rethrow: a swallowed failure here leaves the previous artifact in place while the job is
      // still marked finished, which is indistinguishable from a successful upload.
      throw err;
    }
  }

  public createStreamUploader({ contentType, key, stream }: { contentType: string; key: string; stream: Readable }) {
    try {
      return new Upload({
        client: this.client,
        queueSize: 4,
        leavePartsOnError: false,
        params: {
          Bucket: this.bucket,
          Body: stream,
          ContentType: contentType,
          Key: key,
          CacheControl: ARTIFACT_CACHE_CONTROL,
        },
      });
    } catch (err) {
      const errString = (err as Error).message;
      this.logger.error(errString);
    }
  }

  public async readFileAsBuffer(key: string): Promise<Buffer | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      if (!res.Body) throw new Error('Invalid or missing body received from S3');
      const chunks: Uint8Array[] = [];
      for await (const chunk of res.Body as Readable) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (err) {
      const errString = (err as Error).message;
      this.logger.error(errString);
    }
    return null;
  }

  /**
   * Returns identity metadata for an object, or null if it doesn't exist (or couldn't be read).
   * Callers use the null result as an existence check; the ETag/LastModified come back on the
   * same HeadObject round trip and are used to version download URLs.
   */
  public async getFileMetadata(key: string): Promise<ObjectMetadata | null> {
    try {
      const r = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      if (r.$metadata.httpStatusCode !== 200) return null;
      return { etag: r.ETag ?? null, lastModified: r.LastModified ?? null };
    } catch (err) {
      const errString = (err as Error).message;
      this.logger.error(errString);
    }
    return null;
  }
}
