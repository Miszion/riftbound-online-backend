#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-.env}"
if [[ -f "${ROOT_DIR}/${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ROOT_DIR}/${ENV_FILE}"
  set +a
fi

for cmd in docker aws; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "'$cmd' is required to build and publish the container image." >&2
    exit 1
  fi
done

AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
ENVIRONMENT="${ENVIRONMENT:-dev}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
if [[ -z "${ACCOUNT_ID}" || "${ACCOUNT_ID}" == "None" ]]; then
  echo "Unable to determine AWS account id. Ensure AWS credentials are configured." >&2
  exit 1
fi

ECR_REGISTRY="${ECR_REGISTRY:-${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com}"
ECR_REPOSITORY="${ECR_REPOSITORY:-riftbound-${ENVIRONMENT}-app}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
DOCKER_PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"
CONTAINER_IMAGE_FILE="${CONTAINER_IMAGE_FILE:-.container-image}"

if ! aws ecr describe-repositories --repository-names "${ECR_REPOSITORY}" --region "${AWS_REGION}" >/dev/null 2>&1; then
  echo "Creating ECR repository ${ECR_REPOSITORY} in ${AWS_REGION}..."
  aws ecr create-repository \
    --repository-name "${ECR_REPOSITORY}" \
    --image-scanning-configuration scanOnPush=true \
    --region "${AWS_REGION}" >/dev/null
fi

LOCAL_IMAGE="${ECR_REPOSITORY}:${IMAGE_TAG}"
REMOTE_IMAGE="${ECR_REGISTRY}/${ECR_REPOSITORY}:${IMAGE_TAG}"

echo "Building ${LOCAL_IMAGE} for ${DOCKER_PLATFORM}..."
docker build --platform "${DOCKER_PLATFORM}" -t "${LOCAL_IMAGE}" "${ROOT_DIR}"

echo "Tagging ${LOCAL_IMAGE} -> ${REMOTE_IMAGE}"
docker tag "${LOCAL_IMAGE}" "${REMOTE_IMAGE}"

echo "Pushing ${REMOTE_IMAGE}..."
docker push "${REMOTE_IMAGE}"

echo -n "${REMOTE_IMAGE}" > "${ROOT_DIR}/${CONTAINER_IMAGE_FILE}"
echo "Container image published: ${REMOTE_IMAGE}"
echo "Stored image reference in ${CONTAINER_IMAGE_FILE}"
