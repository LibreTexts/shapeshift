import { JobService } from '../services/job';
import { getEnvironment } from '../lib/environment';
import { QueueClient } from '../lib/queueClient';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import zod from 'zod';
import { Response } from 'express';
import { validators } from '../api/validators';
import { extractIPFromHeaders, ZodRequest } from '../helpers';
import { APIWorkerEnvironment } from '../lib/apiWorkerEnvironment';
import { LogLayer } from 'loglayer';
import { log as logService } from '../lib/log';

export class JobController {
  private readonly logger: LogLayer;
  private readonly logName = 'JobController';

  constructor() {
    this.logger = logService.child().withContext({ logSource: this.logName });
  }

  public async create(req: ZodRequest<zod.infer<typeof validators.job.create>>, res: Response) {
    const data = req.body;
    const jobModel = new JobService();
    const { isHighPriority, url } = data;
    const requesterIp = extractIPFromHeaders(req);
    const jobId = await jobModel.create({
      isHighPriority,
      requesterIp,
      url,
    });
    this.logger.withMetadata({ isHighPriority, jobId, requesterIp, url }).info('Job created.');

    if (getEnvironment() !== 'DEVELOPMENT') {
      const sqsClient = QueueClient.getClient();
      await sqsClient.send(
        new SendMessageCommand({
          MessageBody: jobId,
          ...(data.highPriority && { MessageDeduplicationId: jobId }),
          QueueUrl: data.highPriority
            ? APIWorkerEnvironment.getEnvironment().SQS_HIGH_PRIORITY_QUEUE_URL
            : APIWorkerEnvironment.getEnvironment().SQS_QUEUE_URL,
        }),
      );
    }

    return res.status(200).send({
      data: {
        id: jobId,
        status: 'created',
      },
      status: 200,
    });
  }

  public async get(req: ZodRequest<zod.infer<typeof validators.job.get>>, res: Response) {
    const jobId = req.params.jobID;
    const jobModel = new JobService();
    const job = await jobModel.get(jobId);
    if (!job) {
      return res.status(404).send({
        msg: `Job with identifier "${jobId}" not found.`,
        status: 404,
      });
    }

    return res.status(200).send({
      data: {
        id: job.id,
        isHighPriority: job.isHighPriority,
        status: job.status,
        url: job.url,
      },
      status: 200,
    });
  }
}
