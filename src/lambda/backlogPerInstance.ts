import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { ECSClient, ListTasksCommand } from '@aws-sdk/client-ecs';
import { Handler } from 'aws-lambda';
import { QueueClient } from '../lib/queueClient';
import { Environment } from '../lib/environment';

type PriorityTarget = {
  serviceName: string;
  metricName: string;
  queueUrl: string;
};

// Builds the list of ECS services to publish backlog-per-instance metrics for.
// The high-priority service is optional: it's only included when its deployment
// (queue, service, and metric) is configured. Each target carries its own queue
// URL so the backlog is measured against the queue that service actually drains.
function getPriorityTargets(): PriorityTarget[] {
  const targets: PriorityTarget[] = [
    {
      serviceName: Environment.getRequired('ECS_SERVICE_NAME'),
      metricName: Environment.getRequired('CLOUDWATCH_BPI_METRIC_NAME'),
      queueUrl: Environment.getRequired('SQS_QUEUE_URL'),
    },
  ];

  const hpServiceName = Environment.getOptional('ECS_SERVICE_NAME_HP');
  const hpMetricName = Environment.getOptional('CLOUDWATCH_BPI_METRIC_NAME_HP');
  const hpQueueUrl = Environment.getOptional('SQS_HIGH_PRIORITY_QUEUE_URL');
  if (hpQueueUrl && hpServiceName && hpMetricName) {
    targets.push({ serviceName: hpServiceName, metricName: hpMetricName, queueUrl: hpQueueUrl });
  }

  return targets;
}

async function computeBacklogPerInstance(serviceName: string, queueUrl: string) {
  const ecsClient = new ECSClient();
  const queueClient = new QueueClient();
  const numMessages = await queueClient.getNumberOfQueuedJobs(queueUrl);

  const tasks = await ecsClient.send(
    new ListTasksCommand({
      cluster: Environment.getRequired('ECS_CLUSTER_NAME'),
      serviceName,
    }),
  );
  const numTasks = tasks.taskArns?.length;
  if (typeof numTasks !== 'number') {
    throw new Error('Did not retrieve number of tasks from cluster');
  }
  if (!numTasks) {
    return 0;
  }
  return numMessages / numTasks;
}

async function updateBacklogPerInstanceMetric(metricValue: number, serviceName: string, metricName: string) {
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
              Value: serviceName,
            },
          ],
          MetricName: metricName,
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
    for (const target of getPriorityTargets()) {
      const backlogPerInstance = await computeBacklogPerInstance(target.serviceName, target.queueUrl);
      await updateBacklogPerInstanceMetric(backlogPerInstance, target.serviceName, target.metricName);
    }
    return { statusCode: 200 };
  } catch (e) {
    return {
      body: JSON.stringify(e),
      statusCode: 400,
    };
  }
};
