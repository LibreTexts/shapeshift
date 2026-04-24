import { JobService } from '../services/job';
import { QueueClient } from '../lib/queueClient';
import zod from 'zod';
import { Op } from 'sequelize';
import { Response } from 'express';
import { validators } from '../api/validators';
import { extractIPFromHeaders, ZodRequest } from '../helpers';
import { LogLayer } from 'loglayer';
import { log as logService } from '../lib/log';
import { Job } from '../model';

export class JobController {
  private readonly logger: LogLayer;
  private readonly logName = 'JobController';
  private readonly queueClient: QueueClient;

  constructor() {
    this.logger = logService.child().withContext({ logSource: this.logName });
    this.queueClient = new QueueClient();
  }

  public async create(req: ZodRequest<zod.infer<typeof validators.job.create>>, res: Response) {
    const { highPriority = false, url } = req.validatedData?.body ?? {};
    const jobModel = new JobService();
    const requesterIp = extractIPFromHeaders(req);
    const jobId = await jobModel.create({
      isHighPriority: highPriority,
      requesterIp,
      url: url!,
    });
    this.logger.withMetadata({ highPriority, jobId, requesterIp, url }).info('Job created.');

    await this.queueClient.sendJobMessage({ isHighPriority: highPriority, jobId });

    return res.status(200).send({
      data: {
        id: jobId,
        status: 'created',
      },
      status: 200,
    });
  }

  public async list(req: ZodRequest<zod.infer<typeof validators.jobs.list>>, res: Response) {
    const limit = req.validatedData?.query?.limit ?? 100;
    const offset = req.validatedData?.query?.offset ?? 0;
    const sort = req.validatedData?.query?.sort ?? 'desc';
    const statusFilter = req.validatedData?.query?.status;
    const { count, rows } = await Job.findAndCountAll({
      attributes: ['bookID', 'id', 'status', 'isHighPriority', 'url', 'createdAt'],
      limit,
      offset,
      order: [['createdAt', sort.toUpperCase()]],
      ...(statusFilter && { where: { status: { [Op.in]: statusFilter } } }),
    });
    return res.status(200).send({
      meta: {
        offset,
        limit,
        total: count,
      },
      data: rows,
      status: 200,
    });
  }

  public async get(req: ZodRequest<zod.infer<typeof validators.job.get>>, res: Response) {
    const jobID = req.validatedData?.params?.jobID;
    const jobModel = new JobService();
    const job = await jobModel.get(jobID!);
    if (!job) {
      return res.status(404).send({
        msg: `Job with identifier "${jobID}" not found.`,
        status: 404,
      });
    }

    return res.status(200).send({
      data: {
        bookID: job.bookID,
        id: job.id,
        isHighPriority: job.isHighPriority,
        status: job.status,
        url: job.url,
      },
      status: 200,
    });
  }
}
