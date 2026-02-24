import { QueueClient } from '../lib/queueClient';
import { BookService } from './book';
import { Environment } from '../lib/environment';
import { PDFService } from './pdf';
import { Job } from '../model';
import { CreationAttributes } from 'sequelize';
import { ThinCCService } from './thinCC';
import { log } from '../lib/log';
import { writeFile } from 'fs/promises';

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

      const useLocalStorage =
        Environment.getOptional(
          'USE_LOCAL_STORAGE',
          Environment.getSystemEnvironment() === 'DEVELOPMENT' ? 'true' : 'false',
        ) === 'true';

      try {
        const bookModel = new BookService();
        const bookID = await bookModel.getIDFromURL(job.url);
        if (!bookID) {
          await this.setStatus(jobMsg.jobId, 'failed');
          await this.finish(jobMsg);
          return;
        }

        const initPages = await bookModel.discoverPages(bookID.lib, bookID.pageNum, true);
        log.debug(`Discovered ${initPages.length} pages for book ${bookID.lib}/${bookID.pageNum}`);
        // write the initPages array to a JSON file for debugging
        await writeFile(`./debug_${bookID.lib}_${bookID.pageNum}_initPages.json`, JSON.stringify(initPages, null, 2));

        const coverPageInfo = initPages.find((page) => page.pageID.toString() === bookID.toString());
        if (!coverPageInfo) {
          throw new Error(`Cover page with ID ${bookID.toString()} not found in discovered pages.`);
        }

        // Check for front/back matter and create if missing
        let didCreateMatter = false;
        const frontMatterExists = bookModel.checkMatterExists(initPages, 'Front');
        const backMatterExists = bookModel.checkMatterExists(initPages, 'Back');

        if (!frontMatterExists) {
          log.warn(`Front matter is missing for book ${bookID.lib}/${bookID.pageNum}. Creating front matter...`);
          await bookModel.createMatter({ mode: 'Front', coverPageInfo });
          didCreateMatter = true;
        }

        if (!backMatterExists) {
          // log.warn(
          //   `Back matter is missing for book ${bookID.lib}/${bookID.pageNum}. Creating back matter...`,
          // );
          // await bookModel.createMatter({ mode: "Back", coverPageInfo });
          // didCreateMatter = true;
        }

        // If we created matter, we need to re-discover pages to get updated structure
        const pages = didCreateMatter ? await bookModel.discoverPages(bookID.lib, bookID.pageNum, true) : initPages;

        // Get flat list of all pages and their HTML content
        const bookContents = await bookModel.getBookContents(bookID, pages);

        // <generate pdf>
        const pdfService = new PDFService(bookID, { useLocalStorage });
        const pdfPath = await pdfService.convertBook(bookContents);
        log.info(`PDF generated at path: ${pdfPath}`);
        // </generate pdf>

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
