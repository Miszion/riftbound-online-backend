#!/bin/bash

# Quick reference for common CDK commands

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

case "${1:-help}" in
  deploy)
    echo "Deploying all stacks..."
    ./scripts/deploy.sh
    ;;
  destroy)
    echo "Destroying all stacks..."
    ./scripts/cleanup.sh
    ;;
  synth)
    echo "Synthesizing CloudFormation template..."
    npm run synth
    ;;
  diff)
    echo "Showing differences..."
    npm run diff
    ;;
  list)
    echo "Listing all stacks..."
    npm run list
    ;;
  build)
    echo "Building TypeScript..."
    npm run build
    ;;
  watch)
    echo "Watching for changes..."
    npm run watch
    ;;
  *)
    echo "Riftbound Online CDK - Quick Reference"
    echo ""
    echo "Usage: ./cdk.sh [command]"
    echo ""
    echo "Commands:"
    echo "  deploy       Deploy all stacks to AWS"
    echo "  destroy      Destroy all stacks"
    echo "  synth        Synthesize CloudFormation templates"
    echo "  diff         Show differences from deployed stacks"
    echo "  list         List all stacks"
    echo "  build        Build TypeScript"
    echo "  watch        Watch for TypeScript changes"
    echo ""
    echo "Environment Variables:"
    echo "  ENVIRONMENT      dev/staging/prod (default: dev)"
    echo "  CONTAINER_IMAGE  ECR image URL (default: nginx:latest)"
    echo "  DESIRED_COUNT    ECS desired task count (default: 2)"
    echo "  TASK_CPU         ECS task CPU (default: 1024)"
    echo "  TASK_MEMORY      ECS task memory (default: 2048)"
    echo ""
    echo "Example:"
    echo "  ENVIRONMENT=prod ./cdk.sh deploy"
    ;;
esac
