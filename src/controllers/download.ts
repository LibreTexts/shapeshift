import { LogLayer } from 'loglayer';
import { log as logService } from '../lib/log';
import { validators } from '../api/validators';
import zod from 'zod';
import { Response } from 'express';
import { StorageService } from '../lib/storageService';
import { Environment } from '../lib/environment';
import { MongoClient } from 'mongodb';
import { extractIPFromHeaders, ZodRequest } from '../util/util';

let mongoClient: MongoClient | null = null;

function getMongoClient(uri: string): MongoClient {
  if (!mongoClient) {
    mongoClient = new MongoClient(uri);
  }
  return mongoClient;
}

interface FormatConfig {
  fileName: string;
  contentType: string;
  // S3 key prefix (directory) the artifact lives under. Defaults to the format name.
  dir?: string;
  // S3 subdirectory under `{dir}/{bookID}/` the artifact lives in, e.g. "Publication".
  subDir?: string;
}

const FORMAT_CONFIG: Record<string, FormatConfig> = {
  content: { fileName: 'Content.pdf', contentType: 'application/pdf', dir: 'pdf', subDir: 'Publication' },
  'cover-amazon': { fileName: 'Cover_Amazon.pdf', contentType: 'application/pdf', dir: 'pdf', subDir: 'Publication' },
  'cover-casewrap': {
    fileName: 'Cover_CaseWrap.pdf',
    contentType: 'application/pdf',
    dir: 'pdf',
    subDir: 'Publication',
  },
  'cover-coilbound': {
    fileName: 'Cover_CoilBound.pdf',
    contentType: 'application/pdf',
    dir: 'pdf',
    subDir: 'Publication',
  },
  'cover-perfectbound': {
    fileName: 'Cover_PerfectBound.pdf',
    contentType: 'application/pdf',
    dir: 'pdf',
    subDir: 'Publication',
  },
  epub: { fileName: 'Publication.epub', contentType: 'application/epub+zip' },
  pages: { fileName: 'Individual.zip', contentType: 'application/zip', dir: 'pdf' },
  pdf: { fileName: 'Full.pdf', contentType: 'application/pdf' },
  publication: { fileName: 'Publication.zip', contentType: 'application/zip', dir: 'pdf' },
  thincc: { fileName: 'LibreText.imscc', contentType: 'application/zip' },
};

export class DownloadController {
  private readonly cloudFrontDistributionDomain: string;
  private readonly logger: LogLayer;
  private readonly logName = 'DownloadController';
  private readonly storageService: StorageService;

  constructor() {
    this.cloudFrontDistributionDomain = Environment.getRequired('CLOUDFRONT_DISTRIBUTION_DOMAIN');
    this.logger = logService.child().withContext({ logSource: this.logName });
    this.storageService = new StorageService();
  }

  public async downloadFile(req: ZodRequest<zod.infer<typeof validators.download.get>>, res: Response) {
    const { bookID, format } = req.params;

    const formatConfig = FORMAT_CONFIG[format];
    if (!formatConfig) {
      return res.status(404).send({ status: 404, msg: `No default file configured for format "${format}".` });
    }

    const s3Key = `${formatConfig.dir ?? format}/${bookID}/${formatConfig.subDir ? `${formatConfig.subDir}/` : ''}${formatConfig.fileName}`;
    const exists = await this.storageService.ensureFileExists(s3Key);
    if (!exists) {
      return res.status(404).send({
        msg: `File with path "${s3Key}" not found.`,
        status: 404,
      });
    }

    const extension = formatConfig.fileName.split('.').pop() ?? format;
    await this.recordDownloadEvent(bookID, formatConfig.fileName, extension);
    const downloadUrl = this.buildDownloadUrl(s3Key, formatConfig.fileName);
    this.logger
      .withMetadata({
        bookID,
        format,
        fileName: formatConfig.fileName,
        requesterIp: extractIPFromHeaders(req),
      })
      .info('File downloaded');
    return res.status(302).redirect(downloadUrl);
  }

  private async recordDownloadEvent(identifier: string, file: string, extension: string): Promise<void> {
    const uri = Environment.getOptional('MONGODB_URI');
    if (!uri) return;

    const database = Environment.getOptional('MONGODB_DATABASE', 'download-stats');
    const collection = Environment.getOptional('MONGODB_COLLECTION', 'download-events');

    try {
      const client = getMongoClient(uri);
      await client.db(database).collection(collection).insertOne({
        identifier,
        file,
        format: extension.toLowerCase(),
        timestamp: new Date(),
      });
    } catch (err) {
      this.logger.withError(err as Error).error('Failed to record download event');
    }
  }

  /**
   * Returns a public CloudFront URL for the given S3 key. The
   * response-content-disposition param is included so browsers always prompt a
   * download with the correct filename regardless of S3 object metadata.
   */
  private buildDownloadUrl(s3Key: string, fileName: string): string {
    const disposition = `attachment; filename="${fileName}"`;
    return `https://${this.cloudFrontDistributionDomain}/${s3Key}?response-content-disposition=${encodeURIComponent(disposition)}`;
  }
}
