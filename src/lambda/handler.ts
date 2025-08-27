import { APIGatewayEvent, Handler } from 'aws-lambda';
import { connectDatabase } from '../model';
import { generateHTTPResponse } from '../helpers';
import { JobController } from '../controllers/job';
import { LambdaHandlerEnvironment } from './lambdaHandlerEnvironment';

export const handleRequest: Handler = async (event: APIGatewayEvent) => {
  if (!event) {
    throw new Error('Event information missing!');
  }
  LambdaHandlerEnvironment.getEnvironment(); // verify environment before continuing
  await connectDatabase();

  const methodPathIdentifier = `${event.httpMethod}:${event.path}`;
  const jobController = new JobController();
  switch (methodPathIdentifier) {
    case 'POST:/api/v1/job':
      return await jobController.create(event);
    case 'GET:/api/v1/job/{jobId}':
      return await jobController.get(event);
    default:
      return generateHTTPResponse({ status: 404 }, event.headers?.origin);
  }
};
