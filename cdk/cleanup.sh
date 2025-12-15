#!/bin/bash

# Cleanup script to destroy all CDK stacks

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENVIRONMENT="${ENVIRONMENT:-dev}"

echo "======================================"
echo "Riftbound Online - Infrastructure Cleanup"
echo "======================================"
echo ""
echo "⚠️  WARNING: This will delete all resources for environment: $ENVIRONMENT"
echo ""

read -p "Are you sure you want to continue? (type 'yes' to confirm) " -r
if [[ ! $REPLY =~ ^yes$ ]]; then
  echo "Cleanup cancelled."
  exit 0
fi

cd "$SCRIPT_DIR"

echo "🗑️  Destroying stacks..."
export ENVIRONMENT="$ENVIRONMENT"

npx cdk destroy --all --force

echo ""
echo "✅ Cleanup complete!"
echo "All resources have been deleted."
