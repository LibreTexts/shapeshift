# Shapeshift
A scalable, distributed system for extracting and transforming LibreTexts content into various export formats.

## Development

Shapeshift services are split into two containers, `shapeshift-api` and `shapeshift-processor`, which use MySQL for job data storage. 

#### Running Prince
The `shapeshift-processor` container relies on the Prince XML binary for PDF generation. To run Prince locally (recommended for best dev experience), you can [download it from the official website](https://www.princexml.com/download/) and ensure it's in your system's PATH. Alternatively, you can set the `PRINCE_BINARY_PATH` environment variable in your `.env` file to point to the Prince executable if it's not in your PATH.

To install the Commercial license for Prince, copy the `license.dat` file to the same directory as the Prince's resources. For example, on Linux & Mac, this is typically `/usr/lib/prince/license`. See the [Prince documentation](https://www.princexml.com/doc/installing/#-on-other-systems) for more details. Note: as of May 2026, the Prince documentation for installing a license file states the license file should be placed in `/usr/local/lib/prince/license`, but in practice, it appears to be `/usr/lib/prince/license` on Linux.

#### Ephermeral MySQL
If you want to start an ephermeral MySQL container for development, you can do so with:
```shell
# Start
docker compose -f docker-compose-mysql.dev.yml up -d
# Stop
docker compose -f docker-compose-mysql.dev.yml down
```

#### Connecting to Locally Installed Resources
If you have an existing local MySQL or LocalStack installation running on your machine, you
can connect to them by enabling host networking mode. Add this config to each service in `docker-compose.dev.yaml`:
```yaml
network_mode: "host"
```
This will allow your Shapeshift containers to connect to the MySQL/LocalStack running on your device using `localhost` as the host name.

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