import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { ECSClient, ListTasksCommand } from '@aws-sdk/client-ecs';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { Handler } from 'aws-lambda';
import { QueueClient } from '../queueClient';

type BacklogPerInstanceEnvironment = {
  cloudwatchMetricName: string;
  cloudwatchNamespace: string;
  ecsClusterName: string;
  ecsServiceName: string;
  sqsQueueURL: string;
};

let environment: BacklogPerInstanceEnvironment;

async function computeBacklogPerInstance() {
  const ecsClient = new ECSClient();
  const queueClient = QueueClient.getClient();
  const queueAttr = await queueClient.send(
    new GetQueueAttributesCommand({
      AttributeNames: ['ApproximateNumberOfMessages'],
      QueueUrl: environment.sqsQueueURL,
    }),
  );
  const numMessagesRaw = queueAttr.Attributes?.ApproximateNumberOfMessages;
  if (!numMessagesRaw) {
    throw new Error('Did not retrieve number of messages from queue');
  }
  const numMessages = Number(numMessagesRaw);

  const tasks = await ecsClient.send(
    new ListTasksCommand({
      cluster: environment.ecsClusterName,
      serviceName: environment.ecsServiceName,
    }),
  );
  const numTasks = tasks.taskArns?.length;
  if (typeof numTasks !== 'number') {
    throw new Error('Did not retrieve number of tasks from cluster');
  }
  return numMessages / numTasks;
}

async function updateBacklogPerInstanceMetric(metricValue: number) {
  const cloudwatchClient = new CloudWatchClient();
  await cloudwatchClient.send(
    new PutMetricDataCommand({
      Namespace: environment.cloudwatchNamespace,
      MetricData: [
        {
          Dimensions: [
            {
              Name: 'ClusterName',
              Value: environment.ecsClusterName,
            },
            {
              Name: 'ServiceName',
              Value: environment.ecsServiceName,
            },
          ],
          MetricName: environment.cloudwatchMetricName,
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
    const environ = {
      cloudwatchMetricName: process.env.CLOUDWATCH_METRIC_NAME,
      cloudwatchNamespace: process.env.CLOUDWATCH_NAMESPACE,
      ecsClusterName: process.env.ECS_CLUSTER_NAME,
      ecsServiceName: process.env.ECS_SERVICE_NAME,
      sqsQueueURL: process.env.SQS_QUEUE_URL,
    };
    Object.entries(environ).forEach(([key, value]) => {
      if (!value) {
        throw new Error(`Missing required environment variable ${key}`);
      }
    });
    environment = environ as BacklogPerInstanceEnvironment;

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
