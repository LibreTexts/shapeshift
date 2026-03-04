#!/usr/bin/env bash

echo "Creating LocalStack resources..."

# Check if awslocal command is available
if ! command -v awslocal &> /dev/null; then
    echo "Error: awslocal command not found. Please install localstack CLI tools."
    exit 1
fi

# Read .env file if it exists
if [ -f .env ]; then
    echo "Loading environment variables from .env file..."
    set -a  # automatically export all variables
    source .env
    set +a
fi

# Validate required LIBKEYS environment variables
echo "Validating environment variables..."
REQUIRED_VARS=(
    "LIBKEYS_PROD_DEV_KEY"
    "LIBKEYS_PROD_DEV_SECRET"
    "LIBKEYS_PROD_CHEM_KEY"
    "LIBKEYS_PROD_CHEM_SECRET"
)

MISSING_VARS=()
for var in "${REQUIRED_VARS[@]}"; do
    if [ -z "${!var}" ]; then
        MISSING_VARS+=("$var")
    fi
done

if [ ${#MISSING_VARS[@]} -ne 0 ]; then
    echo "Error: The following required environment variables are missing or empty:"
    for var in "${MISSING_VARS[@]}"; do
        echo "  - $var"
    done
    exit 1
fi

echo "All required environment variables found."

# Create SQS queues
awslocal sqs create-queue --queue-name "high-priority-queue"
echo "Created SQS queue: high-priority-queue"
awslocal sqs create-queue --queue-name "standard-queue"
echo "Created SQS queue: standard-queue"

# Create SSM parameters for library keys
awslocal ssm put-parameter \
    --name "/libkeys/production/dev/key" \
    --type "SecureString" \
    --value "${LIBKEYS_PROD_DEV_KEY}" \
    --overwrite
echo "Created SSM parameter: /libkeys/production/dev/key"

awslocal ssm put-parameter \
    --name "/libkeys/production/dev/secret" \
    --type "SecureString" \
    --value "${LIBKEYS_PROD_DEV_SECRET}" \
    --overwrite
echo "Created SSM parameter: /libkeys/production/dev/secret"

awslocal ssm put-parameter \
    --name "/libkeys/production/chem/key" \
    --type "SecureString" \
    --value "${LIBKEYS_PROD_CHEM_KEY}" \
    --overwrite
echo "Created SSM parameter: /libkeys/production/chem/key"

awslocal ssm put-parameter \
    --name "/libkeys/production/chem/secret" \
    --type "SecureString" \
    --value "${LIBKEYS_PROD_CHEM_SECRET}" \
    --overwrite
echo "Created SSM parameter: /libkeys/production/chem/secret"

echo "LocalStack resources created successfully!"