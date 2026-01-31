import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { ProcessorWorkerEnvironment } from './processorWorkerEnvironment';
import { log as logService } from './log';
import { LogLayer } from 'loglayer';
import { Readable } from 'node:stream';

export class StorageService {
  private readonly client: S3Client;
  private readonly logger: LogLayer;
  private readonly logName = 'StorageService';

  constructor() {
    this.logger = logService.child().withContext({ logSource: this.logName });
    const env = ProcessorWorkerEnvironment.getEnvironment();
    this.client = new S3Client({ region: env.AWS_REGION });
  }

  public async uploadFile({ contentType, data, key }: { contentType: string; data: Buffer; key: string }) {
    try {
      const env = ProcessorWorkerEnvironment.getEnvironment();
      const uploader = new Upload({
        client: this.client,
        queueSize: 4,
        leavePartsOnError: false,
        params: {
          Bucket: env.BUCKET,
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
      const env = ProcessorWorkerEnvironment.getEnvironment();
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: env.BUCKET,
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
      const env = ProcessorWorkerEnvironment.getEnvironment();
      const r = await this.client.send(
        new HeadObjectCommand({
          Bucket: env.BUCKET,
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
