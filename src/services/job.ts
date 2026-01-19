import { QueueClient } from '../lib/queueClient';
import { DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { ProcessorWorkerEnvironment } from '../lib/processorWorkerEnvironment';
import { BookService } from './book';
import { getEnvironment } from '../lib/environment';
import { PDFService } from './pdf';
import { Job } from '../model';
import { CreationAttributes } from 'sequelize';
import { ThinCCService } from './thinCC';

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
    await this.setStatus(jobMsg.jobId, 'inprogress');
    const job = await this.get(jobMsg.jobId);
    if (!job?.url) return;

    // <shift the shape>
    const bookModel = new BookService();
    const bookID = await bookModel.getIDFromURL(job.url);
    if (!bookID) {
      await this.setStatus(jobMsg.jobId, 'failed');
      await this.finish(jobMsg);
      return;
    }

    const pages = await bookModel.discoverPages(bookID.lib, bookID.pageID);

    // FIXME: will discoverPages need to be called again if the matter was just now created?
    await bookModel.createMatter({ mode: 'Front', pageInfo: pages });
    await bookModel.createMatter({ mode: 'Back', pageInfo: pages });

    const pdfService = new PDFService();
    await pdfService.convertBook({ bookID, pages });

    const thinCCService = new ThinCCService();
    await thinCCService.convertBook(pages);
    // </shift the shape>

    await this.finish(jobMsg);
  }

  public async setStatus(id: string, newStatus: JobStatus) {
    await Job.update({ status: newStatus }, { where: { id } });
  }

  public async finish(job: JobQueueMessage) {
    await this.setStatus(job.jobId, 'finished');

    if (getEnvironment() === 'DEVELOPMENT') return;
    const client = QueueClient.getClient();
    await client.send(
      new DeleteMessageCommand({
        QueueUrl: ProcessorWorkerEnvironment.getEnvironment().SQS_QUEUE_URL,
        ReceiptHandle: job.receiptHandle,
      }),
    );
  }
}
