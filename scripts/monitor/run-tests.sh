#!/bin/bash
# Riftbound Engine - Continuous Test Runner
# Runs via PM2 cron, logs results, alerts on failure

set -euo pipefail

BACKEND_DIR="/Users/miszion/workplace/riftbound-online-backend"
LOG_DIR="$BACKEND_DIR/logs/monitor"
TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)
LOG_FILE="$LOG_DIR/test-$TIMESTAMP.log"
LATEST_LINK="$LOG_DIR/latest.log"
STATUS_FILE="$LOG_DIR/status.json"

mkdir -p "$LOG_DIR"

echo "=== Riftbound Engine Test Run: $(date) ===" > "$LOG_FILE"

cd "$BACKEND_DIR"

# Run tests with coverage
if npm test -- --ci --forceExit --coverage 2>&1 | tee -a "$LOG_FILE"; then
  STATUS="pass"
  # Extract test summary
  TESTS_PASSED=$(grep -oE '[0-9]+ passed' "$LOG_FILE" | head -1 || echo "unknown")
  TESTS_TOTAL=$(grep -E '^Tests:' "$LOG_FILE" | sed 's/^Tests:[[:space:]]*//' | head -1 || echo "unknown")
else
  STATUS="fail"
  TESTS_PASSED="0"
  TESTS_TOTAL="unknown"
fi

# Write status
cat > "$STATUS_FILE" << EOF
{
  "status": "$STATUS",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "tests_passed": "$TESTS_PASSED",
  "tests_total": "$TESTS_TOTAL",
  "log_file": "$LOG_FILE"
}
EOF

# Update latest symlink
ln -sf "$LOG_FILE" "$LATEST_LINK"

# Keep only last 50 test logs
ls -t "$LOG_DIR"/test-*.log 2>/dev/null | tail -n +51 | xargs rm -f 2>/dev/null || true

echo "Status: $STATUS" >> "$LOG_FILE"

if [ "$STATUS" = "fail" ]; then
  echo "[ALERT] Riftbound tests FAILED at $(date)" >&2
  exit 1
fi
