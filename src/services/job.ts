import { QueueClient } from '../lib/queueClient';
import { BookService } from './book';
import { Environment } from '../lib/environment';
import { PDFService } from './pdf';
import { Job } from '../model';
import { CreationAttributes } from 'sequelize';
import { ThinCCService } from './thinCC';
import { log } from '../lib/log';

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
  private readonly queueClient: QueueClient;

  constructor() {
    this.queueClient = new QueueClient();
  }

  public async create(input: CreationAttributes<Job>) {
    const job = await Job.create({
      ...input,
      status: 'created',
    });
    return job.id;
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
      await this.setStatus(jobMsg.jobId, 'inprogress');
      const job = await this.get(jobMsg.jobId);
      if (!job?.url) return;

      const pdfService = new PDFService();

      try {
        // <shift the shape>
        const bookModel = new BookService();
        const bookID = await bookModel.getIDFromURL(job.url);
        if (!bookID) {
          await this.setStatus(jobMsg.jobId, 'failed');
          await this.finish(jobMsg);
          return;
        }

        const initPages = await bookModel.discoverPages(bookID.lib, bookID.pageID);

        // Check for front/back matter and create if missing
        let didCreateMatter = false;
        const frontMatterExists = bookModel.checkMatterExists(initPages, 'Front');
        const backMatterExists = bookModel.checkMatterExists(initPages, 'Back');

        if (!frontMatterExists) {
          log.warn(`Front matter is missing for book ${bookID.lib}/${bookID.pageID}. Creating front matter...`);
          await bookModel.createMatter({ mode: 'Front', pageInfo: initPages });
          didCreateMatter = true;
        }

        if (!backMatterExists) {
          log.warn(`Back matter is missing for book ${bookID.lib}/${bookID.pageID}. Creating back matter...`);
          await bookModel.createMatter({ mode: 'Back', pageInfo: initPages });
          didCreateMatter = true;
        }

        // If we created matter, we need to re-discover pages to get updated structure
        const pages = didCreateMatter
          ? await bookModel.discoverPages(bookID.lib, bookID.pageID)
          : initPages;


        await pdfService.convertBook({
          bookID,
          pages,
          options: {
            forceRestart: false, // Set to true to clear checkpoints and start fresh
            jobId: jobMsg.jobId,
            onProgress: (progress) => {
              log.info(`Progress: ${progress.current}/${progress.total} - ${progress.status}`);
            },
          },
        });

        const thinCCService = new ThinCCService();
        await thinCCService.convertBook(pages);
        // </shift the shape>

        await this.finish(jobMsg);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log.error(`Job failed: ${errorMsg}`);
        await this.setStatus(jobMsg.jobId, 'failed');
      } finally {
        // Always cleanup browser resources
        await pdfService.cleanup();
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`A fatal error occurred while running the job: ${errorMsg}`);
    }
  }

  public async setStatus(id: string, newStatus: JobStatus) {
    await Job.update({ status: newStatus }, { where: { id } });
  }

  public async finish(job: JobQueueMessage) {
    await this.setStatus(job.jobId, 'finished');

    if (Environment.getSystemEnvironment() === 'DEVELOPMENT') return;
    await this.queueClient.deleteJobMessage(job.receiptHandle);
  }
}
