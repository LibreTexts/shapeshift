# Shapeshift
A scalable, distributed system for extracting and transforming LibreTexts content into various export formats.

## Development

### MySQL
Shapeshift uses MySQL for job data storage. An existing MySQL setup can be connected via environment variables or you
can use the Docker Compose to run an ephemeral instance.
```shell
# Start
docker compose -f docker-compose-mysql.dev.yml up -d
# Stop
docker compose -f docker-compose-mysql.dev.yml down
```

### Run Development Build
You can use the `run-dev-build.sh` script to build and start the API and Processor containers with your local changes. The first build may take a few moments; subsequent builds will be faster.
```shell
./run-dev-build.sh
```
Use Control-C to stop the containers.

### AWS Emulation
[LocalStack](https://localstack.cloud) can be used to emulate AWS services (like SQS and Secrets Manager) locally as a
Docker container, allowing you to test the entire job workflow end-to-end. Create a free account and
[install the CLI](https://docs.localstack.cloud/aws/getting-started/installation/) to get started. Set the `AWS_REGION`,
`LOCALSTACK_HOST`, and `LOCALSTACK_PORT` environment variables appropriately. Test data is stored on your machine unless
the Cloud Pods feature is used.

## License
[MIT](https://github.com/LibreTexts/shapeshift/blob/main/LICENSE.md)