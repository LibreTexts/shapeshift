import { LogLayer } from 'loglayer';
import { log as logService } from '../lib/log';
import { validators } from '../api/validators';
import zod from 'zod';
import { Response } from 'express';
import { extractIPFromHeaders, ZodRequest } from '../helpers';
import { StorageService } from '../lib/storageService';
import { getSignedUrl } from '@aws-sdk/cloudfront-signer';
import { Environment } from '../lib/environment';

interface FormatConfig {
  fileName: string;
  contentType: string;
}

const FORMAT_CONFIG: Record<string, FormatConfig> = {
  pdf: { fileName: 'Full.pdf', contentType: 'application/pdf' },
  epub: { fileName: 'Publication.epub', contentType: 'application/epub+zip' },
  thincc: { fileName: 'LibreText.imscc', contentType: 'application/zip' },
  pages: { fileName: 'Individual.zip', contentType: 'application/zip' },
  publication: { fileName: 'Publication.zip', contentType: 'application/zip' },
};

export class DownloadController {
  private readonly cloudFrontDistributionDomain: string;
  private readonly cloudFrontKeyPairId: string;
  private readonly cloudFrontPrivateKey: string;
  private readonly logger: LogLayer;
  private readonly logName = 'DownloadController';
  private readonly storageService: StorageService;

  constructor() {
    this.cloudFrontDistributionDomain = Environment.getRequired('CLOUDFRONT_DISTRIBUTION_DOMAIN');
    this.cloudFrontKeyPairId = Environment.getRequired('CLOUDFRONT_KEY_PAIR_ID');
    this.cloudFrontPrivateKey = Environment.getRequired('CLOUDFRONT_PRIVATE_KEY');
    this.logger = logService.child().withContext({ logSource: this.logName });
    this.storageService = new StorageService();
  }

  public async downloadFile(req: ZodRequest<zod.infer<typeof validators.download.get>>, res: Response) {
    const { bookID, format, fileName: fileNameParam } = req.params;

    let fileName: string;
    if (fileNameParam) {
      fileName = fileNameParam;
    } else {
      const formatConfig = FORMAT_CONFIG[format];
      if (!formatConfig) {
        return res.status(404).send({ status: 404, msg: `No default file configured for format "${format}".` });
      }
      fileName = formatConfig.fileName;
    }

    const s3Key = `${format}/${bookID}/${fileName}`;
    const exists = await this.storageService.ensureFileExists(s3Key);
    if (!exists) {
      return res.status(404).send({
        msg: `File with path "${s3Key}" not found.`,
        status: 404,
      });
    }

    // TODO: record download event
    const downloadUrl = this.buildDownloadUrl(s3Key, fileName);
    this.logger
      .withMetadata({
        bookID,
        format,
        fileName,
        requesterIp: extractIPFromHeaders(req),
      })
      .info('File downloaded');
    return res.status(302).redirect(downloadUrl);
  }

  /**
   * Returns a signed CloudFront URL for the given S3 key. The
   * response-content-disposition param is included so browsers always prompt a
   * download with the correct filename regardless of S3 object metadata.
   *
   * TODO: skip signing for public books once book-level visibility is implemented.
   */
  private buildDownloadUrl(s3Key: string, fileName: string): string {
    const disposition = `attachment; filename="${fileName}"`;
    const baseUrl = `https://${this.cloudFrontDistributionDomain}/${s3Key}?response-content-disposition=${encodeURIComponent(disposition)}`;

    const inFiveMinutes = new Date();
    inFiveMinutes.setMinutes(inFiveMinutes.getMinutes() + 5);
    return getSignedUrl({
      dateLessThan: inFiveMinutes.toString(),
      keyPairId: this.cloudFrontKeyPairId,
      privateKey: Buffer.from(this.cloudFrontPrivateKey, 'base64').toString('utf-8'),
      url: baseUrl,
    });
  }
}
