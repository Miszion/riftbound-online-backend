#!/bin/bash

# Build script for Lambda functions (TypeScript)
# This script compiles TypeScript and packages Lambda functions into zip files

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Building Lambda functions..."

# Function to build Lambda
build_lambda() {
  local func_name=$1
  local func_dir="$SCRIPT_DIR/$func_name"
  
  if [ ! -d "$func_dir" ]; then
    echo "❌ Directory $func_dir not found"
    return 1
  fi
  
  echo "📦 Building $func_name..."
  
  cd "$func_dir"
  
  # Install dependencies
  npm install
  
  # Compile TypeScript
  npm run build
  
  # Create zip file with compiled code
  zip -r "$SCRIPT_DIR/$func_name.zip" dist node_modules package.json -q
  
  echo "✅ $func_name packaged to $func_name.zip"
}

# Build all Lambda functions
build_lambda "sign_in"
build_lambda "sign_up"
build_lambda "refresh_token"

echo ""
echo "✅ All Lambda functions built successfully!"
echo ""
echo "Lambda zip files are ready in: $SCRIPT_DIR"
echo "- sign_in.zip"
echo "- sign_up.zip"
echo "- refresh_token.zip"

