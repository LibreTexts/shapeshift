import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { log as logService } from './log';
import { LogLayer } from 'loglayer';
import { Readable } from 'node:stream';
import { Environment } from './environment';

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
        },
      });
      await uploader.done();
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

  public async ensureFileExists(key: string) {
    try {
      const r = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      return !(r.$metadata.httpStatusCode !== 200);
    } catch (err) {
      const errString = (err as Error).message;
      this.logger.error(errString);
    }
    return false;
  }
}
