import { LogLayer } from 'loglayer';
import { log as logService } from '../lib/log';
import { validators } from '../api/validators';
import zod from 'zod';
import { Response } from 'express';
import { ObjectMetadata, StorageService } from '../lib/storageService';
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
  thincc: { fileName: 'LibreText.imscc', contentType: 'application/octet-stream' },
};

/**
 * Builds a short, URL-safe token identifying the current version of a stored object. Prefers the
 * ETag (which changes whenever the object's contents change) and falls back to the last-modified
 * timestamp. Returns null when neither is available, in which case the URL is left unversioned.
 */
function buildVersionToken(metadata: ObjectMetadata): string | null {
  const etag = metadata.etag?.replace(/"/g, '').trim();
  if (etag) return encodeURIComponent(etag);
  if (metadata.lastModified) return metadata.lastModified.getTime().toString(36);
  return null;
}

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
    const metadata = await this.storageService.getFileMetadata(s3Key);
    if (!metadata) {
      return res.status(404).send({
        msg: `File with path "${s3Key}" not found.`,
        status: 404,
      });
    }

    const extension = formatConfig.fileName.split('.').pop() ?? format;
    await this.recordDownloadEvent(bookID, formatConfig.fileName, extension);
    const downloadUrl = this.buildDownloadUrl(s3Key, formatConfig.fileName, buildVersionToken(metadata));
    this.logger
      .withMetadata({
        bookID,
        format,
        fileName: formatConfig.fileName,
        requesterIp: extractIPFromHeaders(req),
      })
      .info('File downloaded');
    // The redirect target is versioned per build, so the redirect itself must never be cached —
    // a cached 302 would pin the client to a previous version token.
    res.set('Cache-Control', 'no-store');
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
   *
   * Object keys are stable across recompiles, so a `v` param derived from the object's current
   * identity is appended: when a book is rebuilt the URL changes, missing any browser or edge
   * cache entry holding the previous build.
   */
  private buildDownloadUrl(s3Key: string, fileName: string, version: string | null): string {
    // Built with encodeURIComponent rather than URLSearchParams: the latter encodes spaces as
    // "+", which S3 does not decode back to a space in response-* overrides.
    const disposition = `attachment; filename="${fileName}"`;
    const versionParam = version ? `&v=${version}` : '';
    return `https://${this.cloudFrontDistributionDomain}/${s3Key}?response-content-disposition=${encodeURIComponent(disposition)}${versionParam}`;
  }
}
