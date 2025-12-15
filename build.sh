#!/bin/bash

# Build script for Riftbound Online Backend
# Compiles TypeScript for:
# - Main server (src/)
# - Match service (src/)
# - CDK infrastructure (cdk/)

set -e

echo "🔨 Building Riftbound Online Backend..."
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ============================================================================
# BUILD MAIN SERVER & MATCH SERVICE
# ============================================================================

echo "${YELLOW}Building main server and match service...${NC}"
npm install
npm run build

if [ -d "dist" ]; then
    echo "${GREEN}✓ Main server and match service compiled${NC}"
    ls -lh dist/
else
    echo "${RED}✗ Failed to compile server${NC}"
    exit 1
fi

echo ""

# ============================================================================
# BUILD CDK
# ============================================================================

echo "${YELLOW}Building CDK...${NC}"

if [ -d "cdk" ]; then
    cd cdk
    npm install > /dev/null 2>&1
    npm run build > /dev/null 2>&1
    
    if [ -f "dist/index.js" ] || [ -f "cdk.out/RiftboundAuth*" ]; then
        echo "${GREEN}✓ CDK compiled${NC}"
    else
        echo "${YELLOW}⚠ CDK may not have compiled correctly${NC}"
    fi
    
    cd ..
else
    echo "${YELLOW}⚠ CDK directory not found, skipping CDK build${NC}"
fi

echo ""

# ============================================================================
# BUILD DOCKER IMAGE
# ============================================================================

echo "${YELLOW}Building Docker image...${NC}"

DOCKER_IMAGE="${DOCKER_REGISTRY:-riftbound}:${IMAGE_TAG:-latest}"

if command -v docker &> /dev/null; then
    docker build -t $DOCKER_IMAGE .
    
    if docker images --format "table {{.Repository}}:{{.Tag}}" | grep -q "$DOCKER_IMAGE"; then
        IMAGE_SIZE=$(docker images --format "table {{.Size}}" $DOCKER_IMAGE | tail -1)
        echo "${GREEN}✓ Docker image built${NC}"
        echo "  Image: $DOCKER_IMAGE"
        echo "  Size: $IMAGE_SIZE"
    else
        echo "${RED}✗ Failed to build Docker image${NC}"
        exit 1
    fi
else
    echo "${YELLOW}⚠ Docker not found, skipping Docker image build${NC}"
fi

echo ""

# ============================================================================
# SUMMARY
# ============================================================================

echo "${GREEN}✅ Build complete!${NC}"
echo ""
echo "Compiled files:"
echo "  - Main server & match service: dist/"
echo "  - CDK: cdk/cdk.out/"
echo "  - Docker image: $DOCKER_IMAGE"
echo ""
echo "Next steps:"
echo "  1. Push Docker image: docker push $DOCKER_IMAGE"
echo "  2. Deploy CDK: cd cdk && npm run deploy"
echo "  3. Update CONTAINER_IMAGE env var with new image"
echo ""
