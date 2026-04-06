import { QueueClient } from '../lib/queueClient';
import { BookService } from './book';
import { Environment } from '../lib/environment';
import { PDFService } from './pdf';
import { Job } from '../model';
import { CreationAttributes } from 'sequelize';
// import { ThinCCService } from './thinCC';
import { log } from '../lib/log';
import { EPUBService } from './epub';

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
      log.debug(`USE_LOCAL_STORAGE is set to ${useLocalStorage}`);

      try {
        const bookModel = new BookService();
        const bookID = await bookModel.getIDFromURL(job.url);
        log.debug(`Extracted book ID: ${bookID?.toString()}`);
        if (!bookID) {
          await this.setStatus(jobMsg.jobId, 'failed');
          await this.finish(jobMsg);
          return;
        }

        const initPages = await bookModel.discoverPages(bookID.lib, bookID.pageNum);
        log.debug(`Discovered ${initPages.flat.length} pages for book ${bookID.toString()}`);

        const coverPageInfo = initPages.flat.find((page) => page.pageID.toString() === bookID.toString());
        if (!coverPageInfo) {
          throw new Error(`Cover page with ID ${bookID.toString()} not found in discovered pages.`);
        }

        // Check for front/back matter and create if missing
        let didCreateMatter = false;
        const frontMatterExists = bookModel.checkMatterExists(initPages, 'Front');
        const backMatterExists = bookModel.checkMatterExists(initPages, 'Back');

        if (!frontMatterExists) {
          log.warn(`Front matter is missing for book ${bookID.toString()}. Creating front matter...`);
          await bookModel.createMatter({ mode: 'Front', coverPageInfo });
          didCreateMatter = true;
        } else {
          log.debug(`Front matter already exists for book ${bookID.toString()}. Skipping creation.`);
        }

        if (!backMatterExists) {
          log.warn(`Back matter is missing for book ${bookID.toString()}. Creating back matter...`);
          await bookModel.createMatter({ mode: 'Back', coverPageInfo });
          didCreateMatter = true;
        } else {
          log.debug(`Back matter already exists for book ${bookID.toString()}. Skipping creation.`);
        }

        // If we created matter, we need to re-discover pages to get updated structure
        const pages = didCreateMatter ? await bookModel.discoverPages(bookID.lib, bookID.pageNum) : initPages;

        // <generate pdf>
        const pdfService = new PDFService(bookID, { useLocalStorage });
        let pdfPath: string | null = null;
        try {
          pdfPath = await pdfService.convertBook(pages);
          log.info(`PDF generated at path: ${pdfPath}`);
        } catch (pdfError) {
          const errorMsg = pdfError instanceof Error ? pdfError.message : String(pdfError);
          log.error(`PDF conversion failed: ${errorMsg}`);
          await pdfService.cleanupWorkdir();
          throw pdfError; // re-throw so the outer catch marks the job as failed
        }
        // </generate pdf>

        // <generate epub>
        const epubService = new EPUBService();
        const epubPath = await epubService.convertBook(pages, { useLocalStorage });
        if (epubPath) log.info(`EPUB generated at path: ${epubPath}`);
        // </generate epub>

        // const thinCCService = new ThinCCService();
        // await thinCCService.convertBook(pages);

        await this.finish(jobMsg);
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

  public async finish(job: JobQueueMessage) {
    await this.setStatus(job.jobId, 'finished');

    if (Environment.getSystemEnvironment() === 'DEVELOPMENT') return;
    await this.queueClient.deleteJobMessage(job.receiptHandle);
  }
}
