import { LogLayer } from 'loglayer';
import { log as logService } from '../lib/log';
import { validators } from '../api/validators';
import zod from 'zod';
import { Response } from 'express';
import { extractIPFromHeaders, ZodRequest } from '../helpers';
import { StorageService } from '../lib/storageService';
import { APIWorkerEnvironment } from '../lib/apiWorkerEnvironment';
import { getSignedUrl } from '@aws-sdk/cloudfront-signer';

export class DownloadController {
  private readonly logger: LogLayer;
  private readonly logName = 'DownloadController';
  private readonly storageService: StorageService;

  constructor() {
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
    const env = APIWorkerEnvironment.getEnvironment();
    const inFiveMinutes = new Date();
    inFiveMinutes.setMinutes(inFiveMinutes.getMinutes() + 5);
    const signedURL = getSignedUrl({
      dateLessThan: inFiveMinutes.toString(),
      keyPairId: env.CLOUDFRONT_KEY_PAIR_ID,
      privateKey: env.CLOUDFRONT_PRIVATE_KEY,
      url: `https://${env.CLOUDFRONT_DISTRIBUTION_DOMAIN}/${path}`,
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
