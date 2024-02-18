export type Job = {
  jobId: string;
  jobIsHighPriority: boolean;
  jobRequesterIp: string;
  jobStatus: JobStatus;
  jobUrl: string;
};

export type JobStatus = 'created' | 'inprogress' | 'finished' | 'failed';

export type LambdaBaseResponse = { status: number };

export type LambdaHandlerEnvironment = {
  sqsHighPriorityQueueURL: string;
  sqsQueueURL: string;
};
