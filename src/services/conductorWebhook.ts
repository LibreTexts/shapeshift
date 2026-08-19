import axios from 'axios';
import PageID from '../util/pageID';
import { LogLayer } from 'loglayer';
import { log as logService } from '../lib/log';
import { Environment } from '../lib/environment';

type BookCompiledWebhookPayload = {
  bookID: PageID;
  /**
   * We let contentPageCount be undefined if it wasn't provided, so Conductor
   * can decide if it wants to retain the last known value or use some other default.
   */
  contentPageCount?: number;
  timestamp: number; // Unix timestamp in milliseconds
};

export class ConductorWebhookService {
  private webhookUrl: string;
  private webhookSecret: string;

  private readonly logger: LogLayer;
  private readonly logName = 'ConductorWebhookService';

  constructor() {
    this.webhookUrl = Environment.getOptional('CONDUCTOR_WEBHOOK_URL') || '';
    this.webhookSecret = Environment.getOptional('CONDUCTOR_WEBHOOK_SECRET') || '';

    if (!this.webhookUrl) {
      throw new Error('CONDUCTOR_WEBHOOK_URL is not defined in environment variables.');
    }

    if (!this.webhookSecret) {
      throw new Error('CONDUCTOR_WEBHOOK_SECRET is not defined in environment variables.');
    }

    this.logger = logService.child().withContext({ logSource: this.logName });
  }

  async sendWebhook(payload: BookCompiledWebhookPayload) {
    try {
      this.logger
        .withMetadata({ bookID: payload.bookID.toString(), timestamp: payload.timestamp, url: this.webhookUrl })
        .info('Sending Conductor webhook');

      await axios.post(
        this.webhookUrl,
        {
          ...payload,
          bookID: payload.bookID.toString(),
          timestamp: payload.timestamp,
          ...(payload.contentPageCount !== undefined ? { contentPageCount: payload.contentPageCount } : {}),
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.webhookSecret}`,
          },
          timeout: 5000, // 5 seconds timeout
        },
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to send webhook to ${this.webhookUrl}:`,
        error.message ? error.message : JSON.stringify(error),
      );
    }
  }
}
