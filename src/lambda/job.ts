import { APIGatewayEvent } from 'aws-lambda';
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { generateHTTPResponse } from '../helpers';
import { Job } from '../types';
import { LambdaBaseResponse, LambdaHandlerEnvironment } from '../types';
import { randomBytes } from 'crypto';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { z } from 'zod';

let environment: LambdaHandlerEnvironment;
const createJobSchema = z.object({
  highPriority: z.boolean(),
  url: z.string().url(),
});
const jobIdSchema = z.string().length(12);

type CreateJobRequest = z.infer<typeof createJobSchema>;
type CreateJobResponse = Pick<Job, 'jobId' | 'jobStatus'>;
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
type JobFoundResponse = LambdaBaseResponse & { data: Omit<Job, 'jobRequesterIp'> };
type JobNotFoundResponse = LambdaBaseResponse & { msg: string };

async function validateCreateJobRequest(rawBody: string): Promise<CreateJobValidatedBody | CreateJobValidationError> {
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

async function validateGetJobRequest(rawInput: string): Promise<GetJobValidatedInput | GetJobValidationError> {
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

export async function handleCreateJobRequest(environ: LambdaHandlerEnvironment, event: APIGatewayEvent) {
  environment = environ;

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
  const validationRes = await validateCreateJobRequest(event.body);
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

  const sqsClient = new SQSClient();
  const dbClient = new DynamoDBClient();

  const jobId = randomBytes(6).toString('hex');
  await dbClient.send(
    new PutItemCommand({
      Item: {
        jobId: {
          S: jobId,
        },
        jobIsHighPriority: {
          BOOL: request.highPriority,
        },
        jobRequesterIp: {
          S: event.requestContext.identity.sourceIp,
        },
        jobStatus: {
          S: 'created',
        },
        jobUrl: {
          S: request.url,
        },
      },
      TableName: 'jobs',
    }),
  );
  await sqsClient.send(
    new SendMessageCommand({
      MessageBody: jobId,
      ...(request.highPriority && { MessageDeduplicationId: jobId }),
      QueueUrl: request.highPriority ? environment.sqsHighPriorityQueueURL : environment.sqsQueueURL,
    }),
  );

  return generateHTTPResponse(
    {
      data: {
        jobId,
        jobStatus: 'created',
      },
      status: 200,
    } as JobCreatedResponse,
    reqOrigin,
  );
}

export async function handleGetJobRequest(environ: LambdaHandlerEnvironment, event: APIGatewayEvent) {
  environment = environ;

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
  const validationRes = await validateGetJobRequest(event.pathParameters.jobId);
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

  const dbClient = new DynamoDBClient();
  const { Item } = await dbClient.send(
    new GetItemCommand({
      Key: {
        jobId: {
          S: jobId,
        },
      },
      TableName: 'jobs',
    }),
  );
  if (!Item) {
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
        jobId: Item.jobId.S,
        jobIsHighPriority: Item.jobIsHighPriority.BOOL,
        jobStatus: Item.jobStatus.S,
        jobUrl: Item.jobUrl.S,
      },
      status: 200,
    } as JobFoundResponse,
    reqOrigin,
  );
}
