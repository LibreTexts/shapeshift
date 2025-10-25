import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { ECSClient, ListTasksCommand } from '@aws-sdk/client-ecs';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { Handler } from 'aws-lambda';
import { QueueClient } from '../lib/queueClient';

const BACKLOG_PER_INSTANCE_ENVIRONMENT_VARIABLES = [
  'CLOUDWATCH_METRIC_NAME',
  'CLOUDWATCH_NAMESPACE',
  'ECS_CLUSTER_NAME',
  'ECS_SERVICE_NAME',
  'SQS_QUEUE_URL',
] as const;
type BacklogPerInstanceEnvironmentVariable = (typeof BACKLOG_PER_INSTANCE_ENVIRONMENT_VARIABLES)[number];
type BacklogPerInstanceEnvironment = Record<BacklogPerInstanceEnvironmentVariable, string>;

let _environment: BacklogPerInstanceEnvironment;

function getEnvironment() {
  if (!_environment) _environment = {} as BacklogPerInstanceEnvironment;
  if (Object.keys(_environment).length === 0) {
    for (const varName of BACKLOG_PER_INSTANCE_ENVIRONMENT_VARIABLES) {
      const v = process.env[varName];
      if (!v) throw new Error(`Missing required environment variable ${varName}`);
      _environment[varName] = v;
    }
  }
  return _environment;
}

async function computeBacklogPerInstance() {
  const environment = getEnvironment();
  const ecsClient = new ECSClient();
  const queueClient = QueueClient.getClient();
  const queueAttr = await queueClient.send(
    new GetQueueAttributesCommand({
      AttributeNames: ['ApproximateNumberOfMessages'],
      QueueUrl: environment.SQS_QUEUE_URL,
    }),
  );
  const numMessagesRaw = queueAttr.Attributes?.ApproximateNumberOfMessages;
  if (!numMessagesRaw) {
    throw new Error('Did not retrieve number of messages from queue');
  }
  const numMessages = Number(numMessagesRaw);

  const tasks = await ecsClient.send(
    new ListTasksCommand({
      cluster: environment.ECS_CLUSTER_NAME,
      serviceName: environment.ECS_SERVICE_NAME,
    }),
  );
  const numTasks = tasks.taskArns?.length;
  if (typeof numTasks !== 'number') {
    throw new Error('Did not retrieve number of tasks from cluster');
  }
  return numMessages / numTasks;
}

async function updateBacklogPerInstanceMetric(metricValue: number) {
  const environment = getEnvironment();
  const cloudwatchClient = new CloudWatchClient();
  await cloudwatchClient.send(
    new PutMetricDataCommand({
      Namespace: environment.CLOUDWATCH_NAMESPACE,
      MetricData: [
        {
          Dimensions: [
            {
              Name: 'ClusterName',
              Value: environment.ECS_CLUSTER_NAME,
            },
            {
              Name: 'ServiceName',
              Value: environment.ECS_SERVICE_NAME,
            },
          ],
          MetricName: environment.CLOUDWATCH_METRIC_NAME,
          StorageResolution: 60,
          Timestamp: new Date(),
          Unit: 'Count',
          Value: metricValue,
        },
      ],
    }),
  );
  return true;
}

export const runMetricUpdate: Handler = async () => {
  try {
    getEnvironment(); // ensure required variables are present
    const backlogPerInstance = await computeBacklogPerInstance();
    await updateBacklogPerInstanceMetric(backlogPerInstance);
    return { statusCode: 200 };
  } catch (e) {
    return {
      body: JSON.stringify(e),
      statusCode: 400,
    };
  }
};
