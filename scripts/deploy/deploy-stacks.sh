#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${ENV_FILE:-.env}"
if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

echo "Building TypeScript sources..."
npm run build

echo "Publishing container image to ECR..."
npm run docker:publish

if [[ ! -f ".container-image" ]]; then
  echo "Missing .container-image file. docker:publish should create this file." >&2
  exit 1
fi

CONTAINER_IMAGE="$(cat .container-image)"
echo "Using container image: ${CONTAINER_IMAGE}"

REDEPLOY_TOKEN="$(date +%s)"
export REDEPLOY_TOKEN

cd cdk
npm install

ENVIRONMENT="${ENVIRONMENT:-dev}" CONTAINER_IMAGE="${CONTAINER_IMAGE}" REDEPLOY_TOKEN="${REDEPLOY_TOKEN}" npx aws-cdk@latest deploy --all
