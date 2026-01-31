import { LogLayer } from 'loglayer';
import { log as logService } from '../lib/log';
import { validators } from '../api/validators';
import zod from 'zod';
import { Response } from 'express';
import { extractIPFromHeaders, ZodRequest } from '../helpers';
import { StorageService } from '../lib/storageService';
import { getSignedUrl } from '@aws-sdk/cloudfront-signer';
import { Environment } from '../lib/environment';

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
    const path = `${req.params.format}/${req.params.bookID}/${req.params.fileName}`;
    const exists = await this.storageService.ensureFileExists(path);
    if (!exists) {
      return res.status(404).send({
        msg: `File with path "${path}" not found.`,
        status: 404,
      });
    }

    // TODO: record download event
    const inFiveMinutes = new Date();
    inFiveMinutes.setMinutes(inFiveMinutes.getMinutes() + 5);
    const signedURL = getSignedUrl({
      dateLessThan: inFiveMinutes.toString(),
      keyPairId: this.cloudFrontKeyPairId,
      privateKey: Buffer.from(this.cloudFrontPrivateKey, 'base64').toString('utf-8'),
      url: `https://${this.cloudFrontDistributionDomain}/${path}`,
    });
    this.logger
      .withMetadata({
        ...req.params,
        requesterIp: extractIPFromHeaders(req),
      })
      .info('File downloaded');
    return res.status(302).redirect(signedURL);
  }
}
