#!/usr/bin/env bash
# Usage: ./run-dev-build

docker compose -f docker-compose.dev.yaml build
docker compose -f docker-compose.dev.yaml up