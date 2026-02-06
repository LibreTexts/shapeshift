# Shapeshift
A scalable, distributed system for extracting and transforming LibreTexts content into various export formats.

## Development

Shapeshift services are split into two containers, `shapeshift-api` and `shapeshift-processor`, which use MySQL for job data storage. 

#### Ephermeral MySQL
If you want to start an ephermeral MySQL container for development, you can do so with:
```shell
# Start
docker compose -f docker-compose-mysql.dev.yml up -d
# Stop
docker compose -f docker-compose-mysql.dev.yml down
```

#### Existing MySQL
If you have an existing local MySQL installation, you can connect to it by adding:
```yaml
extra_hosts:
    - "host.docker.internal:host-gateway"
```
to each service in `docker-compose.dev.yaml` and then setting the `DB_HOST` variable to `host.docker.internal`.

#### The Main Stack
After MySQL is set up, start/stop the stack with:
```shell
# Start
docker compose -f docker-compose.dev.yaml up -d
# Stop
docker compose -f docker-compose.dev.yaml down
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

### Running a Test Request
```bash
curl --request POST \
  --url http://localhost:80/api/v1/job \
  --header 'content-type: application/json' \
  --data '{"url":"https://dev.libretexts.org/Sandboxes/eaturner_at_ucdavis.edu/Test_Book","highPriority":false}'
```


## License
[MIT](https://github.com/LibreTexts/shapeshift/blob/main/LICENSE.md)