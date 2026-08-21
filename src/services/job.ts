import { QueueClient } from '../lib/queueClient';
import { BookService } from './book';
import { Environment } from '../lib/environment';
import { PDFService } from './pdf';
import { Job, sequelize } from '../model';
import { CreationAttributes, Op, Transaction } from 'sequelize';
import { ThinCCService } from './thinCC';
import { log } from '../lib/log';
import { EPUBService } from './epub';
import { isCoverpage } from '../util/bookHelpers';
import { sleep } from '../util/util';
import { LegacyAPIService } from './legacy-api';
import { ConductorWebhookService } from './conductorWebhook';
import PageID from '../util/pageID';

export type JobOutputFormat = 'EPUB' | 'PDF' | 'ThinCC';

export type JobQueueMessageRawBody = {
  jobId: string;
  isHighPriority?: boolean;
};

export type JobQueueMessage = {
  jobId: string;
  isHighPriority: boolean;
  receiptHandle: string;
};

export type JobStatus = 'created' | 'inprogress' | 'finished' | 'failed';

export class JobService {
  /** Statuses that mean a job has not reached a terminal outcome yet. */
  private static readonly activeStatuses: JobStatus[] = ['created', 'inprogress'];
  /** Attempts allowed for a job insert that loses a lock race against a concurrent submission. */
  private static readonly createMaxAttempts = 3;

  private readonly allFormats: JobOutputFormat[];
  private readonly queueClient: QueueClient;
  private readonly conductorWebhookService?: ConductorWebhookService;

  constructor() {
    this.allFormats = ['EPUB', 'PDF', 'ThinCC'];
    this.queueClient = new QueueClient();

    /** Initialize the ConductorWebhookService only if the webhook URL is provided in the environment variables.
     *  Syncing with Conductor is a nicety, not a requirement, so the error is just caught and logged
     * if the webhook service cannot be initialized, and the service will continue to function without it.
     */
    if (Environment.getOptional('CONDUCTOR_WEBHOOK_URL')) {
      try {
        this.conductorWebhookService = new ConductorWebhookService();
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log.warn(`Conductor webhook notifications are disabled: ${errorMsg}`);
        this.conductorWebhookService = undefined;
      }
    }
  }

  public async create(input: CreationAttributes<Job>) {
    const job = await Job.create({
      ...input,
      status: 'created',
    });
    return job.id;
  }

  /**
   * Number of minutes after which an unfinished job is presumed dead rather than active.
   *
   * There is no heartbeat on a running job and the SQS message is deleted before processing starts
   * (see workers/processor.ts), so a worker that crashes or is killed mid-job leaves its row stuck
   * on 'inprogress' forever. Without a cutoff, that row would block every future submission for the
   * same book.
   */
  private getStaleAfterMinutes() {
    const parsed = Number.parseInt(Environment.getOptional('JOB_STALE_AFTER_MINUTES', '15'));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 15;
  }

  /**
   * Finds a job for `bookID` that is still plausibly being worked on, i.e. it hasn't reached a
   * terminal status and its last status change is recent enough that it isn't presumed dead.
   */
  public async findActiveByBookID(
    bookID: string,
    opts?: { lock?: boolean; transaction?: Transaction },
  ): Promise<Job | null> {
    const cutoff = new Date(Date.now() - this.getStaleAfterMinutes() * 60_000);
    return Job.findOne({
      where: {
        bookID,
        status: { [Op.in]: JobService.activeStatuses },
        updatedAt: { [Op.gt]: cutoff },
      },
      order: [['createdAt', 'DESC']],
      transaction: opts?.transaction,
      ...(opts?.lock && { lock: Transaction.LOCK.UPDATE }),
    });
  }

  /**
   * Creates a job unless an equivalent one is already in flight for the same book, in which case
   * the existing job is returned instead and nothing is queued.
   *
   * The check and the insert share one transaction, which does two things. It pins both statements
   * to the writer, so a lagging read replica can't answer "no active job" with stale data. And the
   * `SELECT ... FOR UPDATE` takes a next-key lock over this book's range of the (bookID, status)
   * index, so a second request for the same book blocks until the first commits rather than reading
   * an empty result and inserting a duplicate alongside it. Both are released on commit, closing
   * the window entirely.
   *
   * Jobs for this book that are past the staleness cutoff are marked 'failed' on the way through,
   * so abandoned rows don't linger as 'inprogress' indefinitely.
   */
  public async createIfNoActiveJob(input: CreationAttributes<Job>): Promise<{ isDuplicate: boolean; job: Job }> {
    const { bookID } = input;

    // Without a book identifier there is nothing to deduplicate against, so create unconditionally.
    if (!bookID) {
      return { isDuplicate: false, job: await Job.create({ ...input, status: 'created' }) };
    }

    /**
     * Two submissions for the same book that arrive together can deadlock: each takes a gap lock
     * over the (empty) range before either inserts, and their insert-intention locks then conflict,
     * so InnoDB rolls one back. Retrying is the resolution, and it lands on the right answer — by
     * the time the loser retries the winner has committed, so it finds that job and reports a
     * duplicate instead of inserting one.
     */
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.tryCreateIfNoActiveJob(input, bookID);
      } catch (error) {
        if (attempt >= JobService.createMaxAttempts || !JobService.isRetriableLockError(error)) throw error;
        log.warn(`Lock contention while creating a job for book ${bookID} (attempt ${attempt}); retrying.`);
        await sleep(attempt * 50);
      }
    }
  }

  /**
   * One attempt at the guarded create. The check and the insert share a transaction, which pins
   * both to the writer (so a lagging read replica can't answer "no active job" with stale data) and
   * holds the `SELECT ... FOR UPDATE` next-key lock over this book's range of the (bookID, status)
   * index until commit, so a concurrent submission can't slip an insert in alongside it.
   */
  private async tryCreateIfNoActiveJob(
    input: CreationAttributes<Job>,
    bookID: string,
  ): Promise<{ isDuplicate: boolean; job: Job }> {
    // Next-key locking requires REPEATABLE READ; READ COMMITTED would drop the gap locks that stop
    // a concurrent insert, so the level is set explicitly rather than inherited from the server.
    return sequelize.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
      async (transaction) => {
        const existing = await this.findActiveByBookID(bookID, { lock: true, transaction });
        if (existing) return { isDuplicate: true, job: existing };

        await this.failStaleJobs(bookID, transaction);
        const job = await Job.create({ ...input, status: 'created' }, { transaction });
        return { isDuplicate: false, job };
      },
    );
  }

  /** True for lock errors that resolve on their own when the statement is simply tried again. */
  private static isRetriableLockError(error: unknown): boolean {
    const err = error as { code?: string; original?: { code?: string }; parent?: { code?: string } };
    const code = err?.original?.code ?? err?.parent?.code ?? err?.code;
    return code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT';
  }

  /**
   * Marks jobs for `bookID` that are past the staleness cutoff as failed, so they stop appearing as
   * unfinished work. Scoped to the one book to keep the write bounded.
   */
  private async failStaleJobs(bookID: string, transaction: Transaction) {
    const cutoff = new Date(Date.now() - this.getStaleAfterMinutes() * 60_000);
    const [affected] = await Job.update(
      { status: 'failed' },
      {
        where: {
          bookID,
          status: { [Op.in]: JobService.activeStatuses },
          updatedAt: { [Op.lte]: cutoff },
        },
        transaction,
      },
    );
    if (affected > 0) {
      log.warn(`Marked ${affected} stale job(s) for book ${bookID} as failed.`);
    }
  }

  public async get(id: string): Promise<Job | null> {
    const foundJob = await Job.findOne({
      where: {
        id,
      },
    });
    if (!foundJob) return null;
    return foundJob;
  }

  public async run(jobMsg: JobQueueMessage) {
    try {
      log.debug(`Starting job with ID ${jobMsg.jobId}`);
      await this.setStatus(jobMsg.jobId, 'inprogress');

      const job = await this.get(jobMsg.jobId);
      log.debug(`Running job with ID ${jobMsg.jobId} and URL ${job?.url}`);
      if (!job?.url) return;

      const useLocalStorage =
        Environment.getOptional(
          'USE_LOCAL_STORAGE',
          Environment.getSystemEnvironment() === 'DEVELOPMENT' ? 'true' : 'false',
        ) === 'true';
      if (Environment.getSystemEnvironment() === 'DEVELOPMENT') {
        log.debug(`USE_LOCAL_STORAGE is set to ${useLocalStorage}`);
      }

      const enabledFormats = Environment.getOptional('ENABLED_FORMATS', this.allFormats.join(',')).split(
        ',',
      ) as JobOutputFormat[];
      log.debug(`ENABLED_FORMATS is set to ${enabledFormats.join(', ')}`);

      try {
        const bookModel = new BookService();
        const bookID = await bookModel.getIDFromURL(job.url);
        log.debug(`Extracted book ID: ${bookID?.toString()}`);
        if (!bookID) {
          await this.setStatus(jobMsg.jobId, 'failed');
          await this.finish(jobMsg);
          return;
        }

        let PDFPrintContentPageCount = 1; // This is a temporary workaround to pass `numPages` to the legacy `endpoint` API until we implement a more robust solution for retrieving book info in bulk

        await job.update({ bookID: bookID.toString() });
        const pages = await bookModel.discoverPages(bookID.lib, bookID.pageNum);
        log.debug(`Discovered ${pages.flat.length} pages for book ${bookID.toString()}`);

        // Single content page (no children) — generate a simple PDF only
        const isSinglePage = pages.flat.length === 1;
        if (isSinglePage) {
          log.info(`Single page detected for ${bookID.toString()}, generating single-page PDF`);
          if (enabledFormats.includes('PDF')) {
            const pdfService = new PDFService(bookID, jobMsg.jobId, { useLocalStorage });
            try {
              const pdfPath = await pdfService.convertSinglePage(pages.tree);
              log.info(`Single-page PDF generated at path: ${pdfPath}`);
            } catch (pdfError) {
              const errorMsg = pdfError instanceof Error ? pdfError.message : String(pdfError);
              log.error(`Single-page PDF conversion failed: ${errorMsg}`);
              await pdfService.cleanupWorkdir();
              throw pdfError;
            }
          }
          await this.finish(jobMsg, bookID, 1);
          return;
        }

        const coverPageInfo = pages.flat.find((page) => page.pageID.toString() === bookID.toString());
        if (!coverPageInfo) {
          throw new Error(`Cover page with ID ${bookID.toString()} not found in discovered pages.`);
        }

        if (isCoverpage(pages.tree) && !bookModel.checkMatterExists(pages, 'Front')) {
          log.warn(`Front matter is missing for book ${bookID.toString()}.`);
        }

        if (isCoverpage(pages.tree) && !bookModel.checkMatterExists(pages, 'Back')) {
          log.warn(`Back matter is missing for book ${bookID.toString()}.`);
        }

        // <generate pdf>
        const pdfService = new PDFService(bookID, jobMsg.jobId, { useLocalStorage });
        let pdfPath: string | null = null;
        if (enabledFormats.includes('PDF')) {
          try {
            const pdfResult = await pdfService.convertBook(pages);
            pdfPath = pdfResult?.filePath || null;
            PDFPrintContentPageCount = pdfResult?.pageCount || 1;
            log.info(`PDF generated at path: ${pdfPath}`);
          } catch (pdfError) {
            const errorMsg = pdfError instanceof Error ? pdfError.message : String(pdfError);
            log.error(`PDF conversion failed: ${errorMsg}`);
            await pdfService.cleanupWorkdir();
            throw pdfError; // re-throw so the outer catch marks the job as failed
          }
        }
        // </generate pdf>

        // <generate epub>
        if (enabledFormats.includes('EPUB')) {
          const epubService = new EPUBService();
          const epubPath = await epubService.convertBook(pages, { useLocalStorage });
          if (epubPath) log.info(`EPUB generated at path: ${epubPath}`);
        }
        // </generate epub>

        // <generate thincc>
        if (enabledFormats.includes('ThinCC')) {
          const thinCCService = new ThinCCService();
          const thinCCPath = await thinCCService.convertBook(pages, { useLocalStorage });
          if (thinCCPath) log.info(`ThinCC generated at path: ${thinCCPath}`);
        }
        // </generate thincc>

        const legacyAPIService = new LegacyAPIService();
        await legacyAPIService.updateBookInfo({ bookID, pageCount: PDFPrintContentPageCount }).catch((legacyError) => {
          const errorMsg = legacyError instanceof Error ? legacyError.message : String(legacyError);
          log.error(`Failed to update legacy API: ${errorMsg}`);
        }); // A legacy API update failure should not cause the whole job to fail, so we catch errors here and log them without re-throwing

        await this.finish(jobMsg, bookID, PDFPrintContentPageCount);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log.error(`Job failed: ${errorMsg}`);
        await this.setStatus(jobMsg.jobId, 'failed');
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`A fatal error occurred while running the job: ${errorMsg}`);
    }
  }

  public async setStatus(id: string, newStatus: JobStatus) {
    await Job.update({ status: newStatus }, { where: { id } });
  }

  public async finish(job: JobQueueMessage, bookID?: PageID, printContentPageCount?: number) {
    await this.setStatus(job.jobId, 'finished');

    if (Environment.getSystemEnvironment() === 'DEVELOPMENT') return;
    await this.queueClient.deleteJobMessage(job.receiptHandle);

    // If the webhook service is configured and we have a valid bookID, notify Conductor,
    // but never let a webhook failure affect job completion.
    if (this.conductorWebhookService && bookID) {
      try {
        await this.conductorWebhookService.sendWebhook({
          bookID,
          contentPageCount: printContentPageCount,
          timestamp: Date.now(),
        });
      } catch (webhookError) {
        const errorMsg = webhookError instanceof Error ? webhookError.message : String(webhookError);
        log.error(`Failed to send conductor webhook: ${errorMsg}`);
      }
    }
  }
}
