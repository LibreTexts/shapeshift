import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { ECSClient, ListTasksCommand } from '@aws-sdk/client-ecs';
import { Handler } from 'aws-lambda';
import { QueueClient } from '../lib/queueClient';
import { Environment } from '../lib/environment';

async function computeBacklogPerInstance() {
  const ecsClient = new ECSClient();
  const queueClient = new QueueClient();
  const numMessages = await queueClient.getNumberOfQueuedJobs();

  const tasks = await ecsClient.send(
    new ListTasksCommand({
      cluster: Environment.getRequired('ECS_CLUSTER_NAME'),
      serviceName: Environment.getRequired('ECS_SERVICE_NAME'),
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
      Namespace: Environment.getRequired('CLOUDWATCH_BPI_METRIC_NAMESPACE'),
      MetricData: [
        {
          Dimensions: [
            {
              Name: 'ClusterName',
              Value: Environment.getRequired('ECS_CLUSTER_NAME'),
            },
            {
              Name: 'ServiceName',
              Value: Environment.getRequired('ECS_SERVICE_NAME'),
            },
          ],
          MetricName: Environment.getRequired('CLOUDWATCH_BPI_METRIC_NAME'),
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
    Environment.load();
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
