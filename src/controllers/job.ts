import { JobService } from '../services/job';
import { BookService } from '../services/book';
import { QueueClient } from '../lib/queueClient';
import zod from 'zod';
import { Op } from 'sequelize';
import { Response } from 'express';
import { validators } from '../api/validators';
import { LogLayer } from 'loglayer';
import { log as logService } from '../lib/log';
import { Job } from '../model';
import { JOB_STAGE_LABELS, MAX_INPROGRESS_PROGRESS } from '../lib/jobProgress';
import { extractIPFromHeaders, getErrorMessage, ZodRequest } from '../util/util';

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

    // Resolve the book up front so a resubmission of work already in flight can be detected before
    // anything is queued. Two URLs can point at the same book (vanity paths, aliases, casing), so
    // the resolved identifier is the only reliable key to deduplicate on.
    const bookID = await this.resolveBookID(url!);

    const { isDuplicate, job } = await jobModel.createIfNoActiveJob({
      ...(bookID && { bookID }),
      isHighPriority: highPriority,
      requesterIp,
      url: url!,
    });

    if (isDuplicate) {
      this.logger
        .withMetadata({ bookID, existingJobId: job.id, existingStatus: job.status, requesterIp, url })
        .info('Duplicate job submission; returning the job already in progress.');
      return res.status(200).send({
        data: {
          duplicate: true,
          id: job.id,
          status: job.status,
        },
        status: 200,
      });
    }

    this.logger.withMetadata({ bookID, highPriority, jobId: job.id, requesterIp, url }).info('Job created.');

    try {
      await this.queueClient.sendJobMessage({ isHighPriority: highPriority, jobId: job.id });
    } catch (error) {
      // The row is already committed. Leaving it on 'created' with no queue message behind it would
      // make it look like active work and block resubmission of this book until it went stale, so
      // fail it explicitly before surfacing the error.
      await jobModel.fail(job.id, `Could not enqueue the job for processing: ${getErrorMessage(error)}`);
      throw error;
    }

    return res.status(200).send({
      data: {
        duplicate: false,
        id: job.id,
        status: 'created',
      },
      status: 200,
    });
  }

  /**
   * Resolves a book URL to its identifier for duplicate detection.
   *
   * This requires a CXOne lookup, which can fail independently of the request being valid. Rather
   * than turn a CXOne outage into a submission outage, a failure here is logged and the job is
   * accepted without a bookID: it simply skips the duplicate check, which is the behavior that
   * existed before deduplication, and the processor resolves the book (or records the failure) as
   * it always has.
   */
  private async resolveBookID(url: string): Promise<string | null> {
    try {
      const bookID = await new BookService().getIDFromURL(url);
      if (!bookID) {
        this.logger.withMetadata({ url }).warn('Could not resolve a book ID from the URL; skipping duplicate check.');
        return null;
      }
      return bookID.toString();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger
        .withMetadata({ error: errorMsg, url })
        .warn('Book ID lookup failed; accepting the job without a duplicate check.');
      return null;
    }
  }

  public async list(req: ZodRequest<zod.infer<typeof validators.jobs.list>>, res: Response) {
    const limit = req.validatedData?.query?.limit ?? 100;
    const offset = req.validatedData?.query?.offset ?? 0;
    const sort = req.validatedData?.query?.sort ?? 'desc';
    const statusFilter = req.validatedData?.query?.status;
    const { count, rows } = await Job.findAndCountAll({
      attributes: ['bookID', 'failureReason', 'id', 'progress', 'stage', 'status', 'isHighPriority', 'url', 'createdAt'],
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
      // Same reconciliation the single-job endpoint applies, so the two describe a job identically.
      // Without it a list row reports the raw column and a client polling the list sees a finished
      // job at whatever percentage it last checkpointed at.
      data: rows.map((job) => ({ ...job.toJSON(), ...JobController.presentProgress(job) })),
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

    const { progress, stage } = JobController.presentProgress(job);
    return res.status(200).send({
      data: {
        bookID: job.bookID,
        failureReason: job.failureReason ?? null,
        id: job.id,
        isHighPriority: job.isHighPriority,
        progress,
        stage,
        status: job.status,
        url: job.url,
      },
      status: 200,
    });
  }

  /**
   * Reconciles the stored progress with the job's status so a client never sees a contradiction:
   * no percentage on a job that hasn't started, and never 100 on one that isn't finished. A failed
   * job keeps whatever it reached, which is the useful part — it says how far it got.
   */
  private static presentProgress(job: Job): { progress: number; stage: string | null } {
    const stored = Math.max(0, Math.min(100, job.progress ?? 0));
    switch (job.status) {
      case 'created':
        return { progress: 0, stage: JOB_STAGE_LABELS.queued };
      case 'finished':
        return { progress: 100, stage: JOB_STAGE_LABELS.complete };
      case 'inprogress':
        return { progress: Math.min(Math.max(stored, 1), MAX_INPROGRESS_PROGRESS), stage: job.stage ?? null };
      default:
        return { progress: stored, stage: job.stage ?? null };
    }
  }
}
