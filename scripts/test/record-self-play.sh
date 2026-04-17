#!/usr/bin/env bash
# record-self-play.sh
# Captures the Riftbound replay viewer playing every match in its manifest
# into a single MP4 session file, plus per-match MP4s and an index.html.
#
# Usage:
#   scripts/test/record-self-play.sh [--matches=N] [--fps=30]
#                                    [--resolution=1920x1080]
#                                    [--speed=4] [--url=http://localhost:4200]
#                                    [--output=/abs/path/session.mp4]
#
# Preconditions:
#   - Viewer dev server running on the given URL (defaults to :4200).
#   - Node + ffmpeg installed; Playwright installed in apps/game-viewer/recording.
#
# The script never pushes anything and writes only to
# <repo>/../nexus-data/riftbound-videos by default.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
VIEWER_DIR="${REPO_ROOT}/apps/game-viewer"
RECORD_DIR="${VIEWER_DIR}/recording"
VIDEOS_DIR="${REPO_ROOT}/../nexus-data/riftbound-videos"
VIEWER_URL="http://localhost:4200"

MATCHES=""
FPS="30"
RESOLUTION="1920x1080"
SPEED="4"
OUTPUT=""

for arg in "$@"; do
  case "$arg" in
    --matches=*)    MATCHES="${arg#*=}" ;;
    --fps=*)        FPS="${arg#*=}" ;;
    --resolution=*) RESOLUTION="${arg#*=}" ;;
    --speed=*)      SPEED="${arg#*=}" ;;
    --url=*)        VIEWER_URL="${arg#*=}" ;;
    --output=*)     OUTPUT="${arg#*=}" ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

mkdir -p "${VIDEOS_DIR}"

echo "[record-self-play] viewer url:   ${VIEWER_URL}"
echo "[record-self-play] videos dir:   ${VIDEOS_DIR}"
echo "[record-self-play] recording dir:${RECORD_DIR}"

# Ensure viewer is up
if ! curl -fsS "${VIEWER_URL}/manifest.json" > /dev/null; then
  echo "[record-self-play] ERROR: viewer not reachable at ${VIEWER_URL}" >&2
  echo "  Start it with: cd ${VIEWER_DIR} && NODE_ENV=development npm run dev" >&2
  exit 1
fi

# Install recording deps if needed
if [ ! -d "${RECORD_DIR}/node_modules/playwright" ]; then
  echo "[record-self-play] installing Playwright..."
  (cd "${RECORD_DIR}" && NODE_ENV=development npm install --include=dev --no-audit --no-fund)
fi

ARGS=(
  "--url=${VIEWER_URL}"
  "--outdir=${VIDEOS_DIR}"
  "--fps=${FPS}"
  "--resolution=${RESOLUTION}"
  "--speed=${SPEED}"
)
[ -n "${MATCHES}" ] && ARGS+=("--matches=${MATCHES}")
[ -n "${OUTPUT}"  ] && ARGS+=("--output=${OUTPUT}")

(cd "${RECORD_DIR}" && node record.mjs "${ARGS[@]}")

echo "[record-self-play] done. Contents of ${VIDEOS_DIR}:"
ls -lh "${VIDEOS_DIR}" | head -40
