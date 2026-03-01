#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Test harness for codex/approach-ab-core.

Runs:
1) cargo test
2) A-mode (agent-proof actions DSL) should pass
3) B-mode (agent-proof-live puppeteer control) should pass
4) C-mode gate should fail without --autoplan-experimental
5) C-mode experimental should pass with --autoplan-experimental true

Usage:
  scripts/test-ab-core.sh [options]

Options:
  --chrome PATH          Chrome/Chromium binary path (auto-detect by default)
  --duration SEC         Duration per capture (default: 9)
  --profile NAME         Capture profile for A/C (default: efficient)
  --out-dir DIR          Output directory (default: proofs/ab-core-test-<timestamp>)
  --skip-cargo-tests     Skip cargo test
  --no-stitch            Skip side-by-side stitched video
  -h, --help             Show this help
USAGE
}

timestamp() {
  date +"%Y%m%d-%H%M%S"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

detect_chrome() {
  if [[ -x "/tmp/puppeteer-browsers/chromium/mac_arm-1591460/chrome-mac/Chromium.app/Contents/MacOS/Chromium" ]]; then
    echo "/tmp/puppeteer-browsers/chromium/mac_arm-1591460/chrome-mac/Chromium.app/Contents/MacOS/Chromium"
    return
  fi
  if [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
    echo "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    return
  fi
  if command -v chromium >/dev/null 2>&1; then
    command -v chromium
    return
  fi
  if [[ -x "/usr/bin/chromium" ]]; then
    echo "/usr/bin/chromium"
    return
  fi
  echo ""
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHROME=""
DURATION="9"
PROFILE="efficient"
OUT_DIR="$ROOT_DIR/proofs/ab-core-test-$(timestamp)"
SKIP_CARGO_TESTS=0
STITCH=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --chrome) CHROME="${2:-}"; shift 2 ;;
    --duration) DURATION="${2:-}"; shift 2 ;;
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --out-dir) OUT_DIR="${2:-}"; shift 2 ;;
    --skip-cargo-tests) SKIP_CARGO_TESTS=1; shift 1 ;;
    --no-stitch) STITCH=0; shift 1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

require_cmd node
require_cmd cargo
require_cmd ffprobe
if [[ "$STITCH" -eq 1 ]]; then
  require_cmd ffmpeg
fi

if [[ -z "$CHROME" ]]; then
  CHROME="$(detect_chrome)"
fi
if [[ -z "$CHROME" ]]; then
  echo "No Chrome/Chromium found. Pass --chrome <path>." >&2
  exit 1
fi
if [[ ! -x "$CHROME" ]]; then
  echo "Chrome path is not executable: $CHROME" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

LOGIN_HTML="file://$ROOT_DIR/examples/actions/login-form.html"
LOGIN_ACTIONS="$ROOT_DIR/examples/actions/login.actions.json"
AUTOPLAN_SPEC="$ROOT_DIR/examples/actions/autoplan-login.spec.json"

A_VIDEO="$OUT_DIR/after-a-actions.mp4"
B_VIDEO="$OUT_DIR/after-b-live.mp4"
C_VIDEO="$OUT_DIR/after-c-autoplan.mp4"

echo "== AB Core Test Harness =="
echo "repo:    $ROOT_DIR"
echo "out-dir: $OUT_DIR"
echo "chrome:  $CHROME"
echo "profile: $PROFILE"
echo "duration:$DURATION"
echo

if [[ "$SKIP_CARGO_TESTS" -eq 0 ]]; then
  echo "[1/5] Running cargo tests..."
  (cd "$ROOT_DIR" && cargo test)
else
  echo "[1/5] Skipping cargo tests."
fi
echo

echo "[2/5] Running A-mode (actions DSL)..."
(cd "$ROOT_DIR" && node ./scripts/agent-proof.mjs \
  --url "$LOGIN_HTML" \
  --mode after \
  --name "ab-core-a-actions" \
  --output "$A_VIDEO" \
  --duration "$DURATION" \
  --profile "$PROFILE" \
  --build false \
  --actions "@$LOGIN_ACTIONS" \
  --chrome "$CHROME")
echo

echo "[3/5] Running B-mode (live puppeteer control)..."
(cd "$ROOT_DIR" && node ./scripts/agent-proof-live.mjs \
  --url "$LOGIN_HTML" \
  --name "ab-core-b-live" \
  --output "$B_VIDEO" \
  --duration "$DURATION" \
  --actions "@$LOGIN_ACTIONS" \
  --chrome "$CHROME")
echo

echo "[4/5] Verifying C-mode gate fails without explicit flag..."
set +e
GATE_OUTPUT="$(cd "$ROOT_DIR" && node ./scripts/agent-proof-autoplan.mjs --spec "$AUTOPLAN_SPEC" 2>&1)"
GATE_STATUS=$?
set -e
if [[ "$GATE_STATUS" -eq 0 ]]; then
  echo "Expected autoplan gate to fail, but command succeeded." >&2
  exit 1
fi
if [[ "$GATE_OUTPUT" != *"AutoPlanner is experimental"* ]]; then
  echo "Autoplan gate failed, but expected message was not found." >&2
  echo "$GATE_OUTPUT" >&2
  exit 1
fi
echo "Gate check passed."
echo

echo "[5/5] Running C-mode with explicit experimental flag..."
(cd "$ROOT_DIR" && node ./scripts/agent-proof-autoplan.mjs \
  --spec "$AUTOPLAN_SPEC" \
  --output "$C_VIDEO" \
  --duration "$DURATION" \
  --profile "$PROFILE" \
  --chrome "$CHROME" \
  --autoplan-experimental true)
echo

A_SIDECAR="$A_VIDEO.proof.json"
B_SIDECAR="$B_VIDEO.proof.json"
C_SIDECAR="$C_VIDEO.proof.json"
C_ACTIONS="$C_VIDEO.autoplan.actions.json"

for path in "$A_VIDEO" "$B_VIDEO" "$C_VIDEO" "$A_SIDECAR" "$B_SIDECAR" "$C_SIDECAR" "$C_ACTIONS"; do
  if [[ ! -f "$path" ]]; then
    echo "Missing expected artifact: $path" >&2
    exit 1
  fi
done

SUMMARY_TSV="$OUT_DIR/summary.tsv"
node -e '
const fs = require("fs");
const [summaryPath, aPath, bPath, cPath] = process.argv.slice(1);
const rows = [
  { id: "A", label: "actions-dsl", sidecar: aPath },
  { id: "B", label: "live-control", sidecar: bPath },
  { id: "C", label: "autoplan-exp", sidecar: cPath },
];
const out = ["id\tmode\tnb_frames\tduration\teffective_fps\tsize_bytes\toutput"];
for (const row of rows) {
  const payload = JSON.parse(fs.readFileSync(row.sidecar, "utf8"));
  const m = payload.metrics || {};
  out.push([
    row.id,
    payload.controlMode || row.label,
    m.nb_frames || "",
    m.duration || "",
    m.effective_fps || "",
    m.size || "",
    payload.output || ""
  ].join("\t"));
}
fs.writeFileSync(summaryPath, out.join("\n") + "\n", "utf8");
' "$SUMMARY_TSV" "$A_SIDECAR" "$B_SIDECAR" "$C_SIDECAR"

# Validate effective fps is sane (>=10) for all modes.
node -e '
const fs = require("fs");
const tsv = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").slice(1);
for (const line of tsv) {
  const [id, , , , eff] = line.split("\t");
  const v = Number(eff);
  if (!Number.isFinite(v) || v < 10) {
    console.error(`Mode ${id} has low or invalid effective_fps: ${eff}`);
    process.exit(1);
  }
}
' "$SUMMARY_TSV"

if [[ "$STITCH" -eq 1 ]]; then
  STITCHED="$OUT_DIR/side-by-side-a-b-c.mp4"
  ffmpeg -y \
    -i "$A_VIDEO" \
    -i "$B_VIDEO" \
    -i "$C_VIDEO" \
    -filter_complex "[0:v]scale=640:-2,setsar=1[v0];[1:v]scale=640:-2,setsar=1[v1];[2:v]scale=640:-2,setsar=1[v2];[v0][v1][v2]hstack=inputs=3[v]" \
    -map "[v]" \
    -c:v libx264 \
    -preset veryfast \
    -crf 23 \
    -shortest \
    "$STITCHED" \
    >/dev/null 2>&1
fi

echo "== PASS =="
echo "Artifacts:"
echo "  A: $A_VIDEO"
echo "  B: $B_VIDEO"
echo "  C: $C_VIDEO"
echo "  C actions: $C_ACTIONS"
if [[ "$STITCH" -eq 1 ]]; then
  echo "  Side-by-side: $OUT_DIR/side-by-side-a-b-c.mp4"
fi
echo
echo "Summary:"
if command -v column >/dev/null 2>&1; then
  column -t -s $'\t' "$SUMMARY_TSV"
else
  cat "$SUMMARY_TSV"
fi
