import { APIGatewayEvent, Handler } from 'aws-lambda';
import { generateHTTPResponse } from '../helpers';
import { handleCreateJobRequest, handleGetJobRequest } from './job';
import { LambdaHandlerEnvironment } from './lambdaHandlerEnvironment';

export const handleRequest: Handler = async (event: APIGatewayEvent) => {
  if (!event) {
    throw new Error('Event information missing!');
  }
  LambdaHandlerEnvironment.getEnvironment(); // verify environment before continuing

  const methodPathIdentifier = `${event.httpMethod}:${event.path}`;
  switch (methodPathIdentifier) {
    case 'POST:/api/v1/job':
      return await handleCreateJobRequest(event);
    case 'GET:/api/v1/job/{jobId}':
      return await handleGetJobRequest(event);
    default:
      return generateHTTPResponse({ status: 404 }, event.headers?.origin);
  }
};
