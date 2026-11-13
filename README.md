# Shapeshift
A scalable, distributed system for extracting and transforming LibreTexts content into various export formats.

## Development

Shapeshift services are split into two containers, `shapeshift-api` and `shapeshift-processor`, which use MySQL for job data storage. You can run these locally with `npm run dev:api` and `npm run dev:processor`, respectively.

### Ephermeral MySQL
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

### Copy .env.example
Copy the .env.example contents to a new `.env` file.

The following variables are not particularly important for local development with LocalStack and can be left at their dummy values for simplicity:
- `AWS_*`
- `BUCKET`
- `CLOUDFRONT_*`
- `CLOUDWATCH_*`
- `ECS_*`

### AWS Emulation
[LocalStack](https://localstack.cloud) can be used to emulate AWS services (like SQS and Secrets Manager) locally as a
Docker container, allowing you to test the entire job workflow end-to-end. Create a free account and
[install the CLI](https://docs.localstack.cloud/aws/getting-started/installation/) to get started. Set the `AWS_REGION`,
`LOCALSTACK_HOST`, and `LOCALSTACK_PORT` environment variables appropriately. Test data is stored on your machine unless
the Cloud Pods feature is used.

### LocalStack Helper Script
The `./create-localstack-resources.sh` script can be run to create the SQS and SSM resources in one shot. This can be done by hand instead, but manually creating the resources each time LocalStack is started can become tedious.

You can copy/modify the script to create additional SSM parameters from your `.env` as needed, but don't commit any changes to keep the process simple for other devs setting up the repo locally for the first time.

### Spin Up
1. In a terminal window, run `localstack start` and wait for it to be ready. Keep the window open with LocalStack running
2. In another terminal window, run `./create-localstack-resources.sh`
3. Then, run `npm run dev:api`
4. In another terminal window, run `npm run dev:processor`

### Running a Test Request
```bash
curl --request POST \
  --url http://localhost:80/api/v1/job \
  --header 'content-type: application/json' \
  --data '{"url":"https://dev.libretexts.org/Sandboxes/eaturner_at_ucdavis.edu/Test_Book","highPriority":false}'
```

### Data Bucket Structure
Shapeshift uses an S3 bucket to store generated exports. The structure should be as follows:

```
{bucket-name}/
├── pdf/
│   └── {book-id}/
│       ├── Preview.pdf
│       └── Full.pdf
├── epub/
│   └── {book-id}/
├── thincc/
│   └── {book-id}/
│       └── LibreText.imscc
├── pages/
│   └── {book-id}/
│       └── Individual.zip
└── publication/
    └── {book-id}/
        ├── Content.pdf
        ├── Cover_Casewrap.pdf
        ├── Cover_PerfectBound.pdf
        ├── Cover_Amazon.pdf
        ├── Cover_CoilBound.pdf
        └── Publication.zip
```

## License
[MIT](https://github.com/LibreTexts/shapeshift/blob/main/LICENSE.md)
