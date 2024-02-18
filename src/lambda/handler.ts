import { APIGatewayEvent, Handler } from 'aws-lambda';
import { generateHTTPResponse } from '../helpers';
import { handleCreateJobRequest, handleGetJobRequest } from './job';
import { LambdaHandlerEnvironment } from '../types';

export const handleRequest: Handler = async (event: APIGatewayEvent) => {
  if (!event) {
    throw new Error('Event information missing!');
  }
  const environ = {
    sqsHighPriorityQueueURL: process.env.SQS_HIGH_PRIORITY_QUEUE_URL,
    sqsQueueURL: process.env.SQS_QUEUE_URL,
  };
  Object.entries(environ).forEach(([key, value]) => {
    if (!value) {
      throw new Error(`Missing required environment variable ${key}`);
    }
  });
  const environment = environ as LambdaHandlerEnvironment;

  const methodPathIdentifier = `${event.httpMethod}:${event.path}`;
  switch (methodPathIdentifier) {
    case 'POST:/api/v1/job':
      return await handleCreateJobRequest(environment, event);
    case 'GET:/api/v1/job/{jobId}':
      return await handleGetJobRequest(environment, event);
    default:
      return generateHTTPResponse({ status: 404 }, event.headers?.origin);
  }
};
