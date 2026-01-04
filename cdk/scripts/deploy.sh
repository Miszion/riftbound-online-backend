#!/bin/bash

# Riftbound Online CDK Deployment Script
# This script deploys the complete infrastructure

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENVIRONMENT="${ENVIRONMENT:-dev}"
CONTAINER_IMAGE="${CONTAINER_IMAGE:-nginx:latest}"
DESIRED_COUNT="${DESIRED_COUNT:-2}"
TASK_CPU="${TASK_CPU:-1024}"
TASK_MEMORY="${TASK_MEMORY:-2048}"

echo "======================================"
echo "Riftbound Online - Infrastructure Deploy"
echo "======================================"
echo ""
echo "Environment: $ENVIRONMENT"
echo "Container Image: $CONTAINER_IMAGE"
echo "Desired Count: $DESIRED_COUNT"
echo "Task CPU: $TASK_CPU"
echo "Task Memory: $TASK_MEMORY"
echo ""

cd "$SCRIPT_DIR"

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Build TypeScript
echo "🔨 Building TypeScript..."
npm run build

# List stacks
echo ""
echo "📋 Available stacks:"
npx cdk list

echo ""
echo "📊 Planning deployment..."
export ENVIRONMENT="$ENVIRONMENT"
export CONTAINER_IMAGE="$CONTAINER_IMAGE"
export DESIRED_COUNT="$DESIRED_COUNT"
export TASK_CPU="$TASK_CPU"
export TASK_MEMORY="$TASK_MEMORY"

npx cdk synth

echo ""
read -p "Do you want to deploy? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo "🚀 Deploying infrastructure..."
  npx cdk deploy --all --require-approval=never
  
  echo ""
  echo "✅ Deployment complete!"
  echo ""
  echo "📌 Stack Outputs:"
  echo "Run: npx cdk list"
  echo "or check CloudFormation console for outputs"
else
  echo "Deployment cancelled."
fi
