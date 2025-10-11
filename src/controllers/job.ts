import { generateHTTPResponse } from '../helpers';
import { JobService } from '../services/job';
import { getEnvironment } from '../lib/environment';
import { QueueClient } from '../lib/queueClient';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { LambdaHandlerEnvironment } from '../lambda/lambdaHandlerEnvironment';
import { APIGatewayEvent } from 'aws-lambda';
import { z } from 'zod';
import { Attributes } from 'sequelize';
import { Job } from '../model';
import { LambdaBaseResponse } from '../helpers';

const createJobSchema = z.object({
  highPriority: z.boolean(),
  url: z.string().url(),
});
const jobIdSchema = z.string().length(12);

type CreateJobRequest = z.infer<typeof createJobSchema>;
type CreateJobResponse = Pick<Attributes<Job>, 'id' | 'status'>;
type CreateJobValidatedBody = {
  valid: true;
  body: CreateJobRequest;
};
type CreateJobValidationError = {
  valid: false;
  errors: string[];
};
type GetJobValidatedInput = {
  valid: true;
  jobId: string;
};
type GetJobValidationError = {
  valid: false;
  errors: string[];
};

type InvalidInputResponse = LambdaBaseResponse & { errors: string[] };
type JobCreatedResponse = LambdaBaseResponse & { data: CreateJobResponse };
type JobFoundResponse = LambdaBaseResponse & { data: Omit<Attributes<Job>, 'requesterIp'> };
type JobNotFoundResponse = LambdaBaseResponse & { msg: string };

export class JobController {
  public async create(event: APIGatewayEvent) {
    const reqOrigin = event.headers?.origin;
    if (!event.body) {
      return generateHTTPResponse(
        {
          status: 400,
          errors: ['Malformed input.'],
        } as InvalidInputResponse,
        reqOrigin,
      );
    }
    const validationRes = await this.validateCreateJobRequest(event.body);
    if (!validationRes.valid) {
      return generateHTTPResponse(
        {
          status: 400,
          errors: validationRes.errors,
        } as InvalidInputResponse,
        reqOrigin,
      );
    }
    const request = validationRes.body;

    const jobModel = new JobService();
    const jobId = await jobModel.create({
      isHighPriority: request.highPriority,
      requesterIp: event.requestContext?.identity?.sourceIp,
      url: request.url,
    });

    if (getEnvironment() !== 'DEVELOPMENT') {
      const sqsClient = QueueClient.getClient();
      await sqsClient.send(
        new SendMessageCommand({
          MessageBody: jobId,
          ...(request.highPriority && { MessageDeduplicationId: jobId }),
          QueueUrl: request.highPriority
            ? LambdaHandlerEnvironment.getEnvironment().sqsHighPriorityQueueURL
            : LambdaHandlerEnvironment.getEnvironment().sqsQueueURL,
        }),
      );
    }

    return generateHTTPResponse(
      {
        data: {
          id: jobId,
          status: 'created',
        },
        status: 200,
      } as JobCreatedResponse,
      reqOrigin,
    );
  }

  public async get(event: APIGatewayEvent) {
    const reqOrigin = event.headers?.origin;
    if (!event.pathParameters?.jobId) {
      return generateHTTPResponse(
        {
          status: 400,
          errors: ['Malformed input.'],
        } as InvalidInputResponse,
        reqOrigin,
      );
    }
    const validationRes = await this.validateGetJobRequest(event.pathParameters.jobId);
    if (!validationRes.valid) {
      return generateHTTPResponse(
        {
          status: 400,
          errors: validationRes.errors,
        } as InvalidInputResponse,
        reqOrigin,
      );
    }
    const jobId = validationRes.jobId;

    const jobModel = new JobService();
    const job = await jobModel.get(jobId);
    if (!job) {
      return generateHTTPResponse(
        {
          status: 404,
          msg: `Job with identifier "${jobId}" not found.`,
        } as JobNotFoundResponse,
        reqOrigin,
      );
    }

    return generateHTTPResponse(
      {
        data: {
          id: job.id,
          isHighPriority: job.isHighPriority,
          status: job.status,
          url: job.url,
        },
        status: 200,
      } as JobFoundResponse,
      reqOrigin,
    );
  }

  private async validateCreateJobRequest(rawBody: string): Promise<CreateJobValidatedBody | CreateJobValidationError> {
    try {
      const parsedInput = JSON.parse(rawBody);
      const result = await createJobSchema.safeParseAsync(parsedInput);
      if (!result.success) {
        const errors: string[] = [];
        for (const issue of result.error.issues) {
          errors.push(issue.message);
        }
        return {
          errors,
          valid: false,
        };
      }
      return {
        valid: true,
        body: parsedInput as CreateJobRequest,
      };
    } catch (e) {
      return {
        valid: false,
        errors: ['Invalid input format.'],
      };
    }
  }

  private async validateGetJobRequest(rawInput: string): Promise<GetJobValidatedInput | GetJobValidationError> {
    const result = await jobIdSchema.safeParseAsync(rawInput);
    if (!result.success) {
      const errors: string[] = [];
      for (const issue of result.error.issues) {
        errors.push(issue.message);
      }
      return {
        errors,
        valid: false,
      };
    }
    return {
      valid: true,
      jobId: rawInput,
    };
  }
}
