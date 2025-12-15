FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy application code
COPY . .

# Build TypeScript
RUN npm run build

# Expose ports
EXPOSE 3000 4000

# Health check (will respond on either port depending on service)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const port = process.env.PORT || 3000; require('http').get('http://localhost:' + port + '/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Determine which service to run based on SERVICE env var
# Default: main server (port 3000)
# MATCH_SERVICE: match service (port 4000)
CMD ["sh", "-c", "if [ \"$SERVICE\" = \"match-service\" ]; then node dist/match-service.js; else node dist/server.js; fi"]

