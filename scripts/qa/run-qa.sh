#!/bin/bash
# Riftbound QA Agent Runner
# Runs the QA agent against the next pending phase in the coverage plan.
# Designed to be called by PM2 on a cron schedule.

set -euo pipefail

PROJECT_DIR="/Users/miszion/workplace/riftbound-online-backend"
QA_PLAN="/Users/miszion/workplace/nexus-data/plans/riftbound-online/qa/coverage-plan.json"
QA_LOGS="/Users/miszion/workplace/riftbound-online-backend/logs/qa"
BUGS_FILE="/Users/miszion/workplace/nexus-data/plans/riftbound-online/bugs.json"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
SESSION_LOG="${QA_LOGS}/session-${TIMESTAMP}.log"

mkdir -p "${QA_LOGS}"

echo "[$(date)] QA Agent starting..."

# Find the next pending phase from the coverage plan
NEXT_PHASE=$(python3 -c "
import json, sys
with open('${QA_PLAN}') as f:
    plan = json.load(f)
for item in plan['queue']:
    if item['status'] == 'pending':
        print(json.dumps(item))
        sys.exit(0)
print('NONE')
")

if [ "$NEXT_PHASE" = "NONE" ]; then
    echo "[$(date)] All QA phases complete. Running regression suite only."
    PHASE_ID="REGRESSION"
    PHASE_NAME="Full Regression Suite"
    TARGET="all"
    APPROACH="Run the full test suite, check for regressions, update coverage numbers"
    TEST_FILE="all"
else
    PHASE_ID=$(echo "$NEXT_PHASE" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
    PHASE_NAME=$(echo "$NEXT_PHASE" | python3 -c "import json,sys; print(json.load(sys.stdin)['name'])")
    TARGET=$(echo "$NEXT_PHASE" | python3 -c "import json,sys; print(json.load(sys.stdin)['target'])")
    APPROACH=$(echo "$NEXT_PHASE" | python3 -c "import json,sys; print(json.load(sys.stdin)['approach'])")
    TEST_FILE=$(echo "$NEXT_PHASE" | python3 -c "import json,sys; print(json.load(sys.stdin)['testFile'])")
fi

echo "[$(date)] Running phase: ${PHASE_ID} - ${PHASE_NAME}"
echo "[$(date)] Target: ${TARGET}"

# Write system prompt to temp file (avoids shell escaping issues)
SYS_PROMPT_FILE="/tmp/riftbound-qa-${TIMESTAMP}.txt"
cat > "$SYS_PROMPT_FILE" << 'SYSPROMPT'
You are the QA Engineer for Riftbound Online, a browser-based TCG with a complex game engine.

IMPORTANT RULES:
- NEVER commit code as Claude, Co-Authored-By Claude, or any AI attribution
- All git commits must be under the name Miszion with email miszion@users.noreply.github.com
- Do NOT commit anything. Just write tests and run them.

## Project Context
- Backend: /Users/miszion/workplace/riftbound-online-backend
- Test framework: Jest with ts-jest
- Test dir: src/__tests__/
- Test helpers: src/__tests__/test-helpers.ts (card factories, engine helpers)
- Bug log: /Users/miszion/workplace/nexus-data/plans/riftbound-online/bugs.json
- QA plan: /Users/miszion/workplace/nexus-data/plans/riftbound-online/qa/coverage-plan.json

## Your Workflow

### Step 1: Read the target source file thoroughly
- Understand every function, every branch, every error path
- Read the existing test-helpers.ts to use the same patterns

### Step 2: Read existing tests for patterns
- Match the existing test style (describe/it blocks, assertion patterns)
- Use the same factories from test-helpers.ts
- Add new factories to test-helpers.ts if needed for your module

### Step 3: Write comprehensive tests
- Cover happy paths, error paths, edge cases, and boundary conditions
- Mock external dependencies (DynamoDB, SQS, Cognito) - never hit real AWS
- Use descriptive test names that explain what's being verified
- Group related tests in describe blocks

### Step 4: Run the tests
- Run: cd /Users/miszion/workplace/riftbound-online-backend && npx jest --verbose 2>&1
- If tests fail, FIX them. Iterate until they pass.
- Then run with coverage: npx jest --coverage 2>&1

### Step 5: File bugs for any issues found
- If you discover actual bugs in the source code while writing tests, file them
- Read the existing bugs.json first, get the next bug ID
- Append to the bugs array, don't overwrite

### Step 6: Update the coverage plan
- Mark your phase as "completed" in coverage-plan.json
- Update the currentCoverage numbers from the coverage report
- Add a session entry with date, phase, tests added, coverage delta

### Step 7: Report
End with a structured report:
```
## QA Session Report - Riftbound Online - [date]
### Phase: [phase ID] - [phase name]
### Tests Written
- [count] new tests in [file]
### Coverage Delta
- Before: X% statements
- After: Y% statements
- Delta: +Z%
### Bugs Found
- [any bugs filed, or "None"]
### Next Priority
- [what should be tackled next]
```
SYSPROMPT

# Build the task prompt
TASK_PROMPT="Phase ${PHASE_ID}: ${PHASE_NAME}

Target file: ${TARGET}
Test file to create/expand: ${TEST_FILE}
Approach: ${APPROACH}

First, read the QA coverage plan at ${QA_PLAN} to understand the full picture.
Then read the target source file and existing tests.
Write comprehensive tests, run them, fix any failures, and update the plan.

Current test count: 72 tests across 4 suites.
Current coverage: 18.12% statements.
Goal: Get this module to 80%+ coverage."

echo "[$(date)] Dispatching to Claude CLI..."

# Run Claude CLI with QA agent config
# Using --output-format text for simplicity in cron context
cd "$PROJECT_DIR"
claude -p "$TASK_PROMPT" \
    --model claude-sonnet-4-6 \
    --max-turns 80 \
    --allowedTools "Read,Write,Edit,Bash,Glob,Grep" \
    --append-system-prompt "$(cat "$SYS_PROMPT_FILE")" \
    < /dev/null \
    2>&1 | tee "${SESSION_LOG}" || true

# Cleanup
rm -f "$SYS_PROMPT_FILE"

echo ""
echo "[$(date)] QA session complete. Log: ${SESSION_LOG}"

# Run final test count
echo "[$(date)] Final test status:"
cd "$PROJECT_DIR" && npx jest --verbose 2>&1 | tail -10 || true

echo "[$(date)] Done."
