#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Side-by-side performance benchmark for Node vs Rust recorder.

Usage:
  scripts/benchmark-side-by-side.sh [options]

Options:
  --chrome PATH       Chrome/Chromium binary path (required if auto-detect fails)
  --runs N            Number of runs per implementation (default: 3)
  --duration SEC      Recording duration per run in seconds (default: 3)
  --width PX          Viewport width (default: 640)
  --height PX         Viewport height (default: 360)
  --fps N             Target FPS (default: 8)
  --url URL           URL to record (default: built-in animated data URL)
  --out-dir DIR       Output directory (default: benchmarks/<timestamp>)
  --rust-bin PATH     Rust binary path (default: ./target/debug/agent-recorder)
  --node-bin PATH     Node binary (default: node)
  -h, --help          Show this help

Outputs:
  <out-dir>/results.csv
  <out-dir>/summary.md
  <out-dir>/<impl>-runN.mp4
  <out-dir>/<impl>-runN.log
  <out-dir>/<impl>-runN.time
USAGE
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

timestamp() {
  date +"%Y%m%d-%H%M%S"
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

CHROME=""
RUNS=3
DURATION=3
WIDTH=640
HEIGHT=360
FPS=8
RUST_BIN="./target/debug/agent-recorder"
NODE_BIN="node"
NODE_SCRIPT="./record.mjs"
URL='data:text/html,<html><body style="margin:0"><h1>Benchmark</h1><script>let i=0;setInterval(()=>{document.body.style.background=i++%2?"#fff":"#ddd"},120)</script></body></html>'
OUT_DIR="benchmarks/$(timestamp)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --chrome) CHROME="${2:-}"; shift 2 ;;
    --runs) RUNS="${2:-}"; shift 2 ;;
    --duration) DURATION="${2:-}"; shift 2 ;;
    --width) WIDTH="${2:-}"; shift 2 ;;
    --height) HEIGHT="${2:-}"; shift 2 ;;
    --fps) FPS="${2:-}"; shift 2 ;;
    --url) URL="${2:-}"; shift 2 ;;
    --out-dir) OUT_DIR="${2:-}"; shift 2 ;;
    --rust-bin) RUST_BIN="${2:-}"; shift 2 ;;
    --node-bin) NODE_BIN="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

require_cmd "$NODE_BIN"
require_cmd ffmpeg
require_cmd ffprobe
require_cmd cargo

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
if [[ ! -f "$NODE_SCRIPT" ]]; then
  echo "Node recorder script not found: $NODE_SCRIPT" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "Building Rust binary..."
cargo build -q
if [[ ! -x "$RUST_BIN" ]]; then
  echo "Rust binary not found after build: $RUST_BIN" >&2
  exit 1
fi

RESULTS_CSV="$OUT_DIR/results.csv"
SUMMARY_MD="$OUT_DIR/summary.md"
SUMMARY_TSV="$OUT_DIR/summary.tsv"
printf "impl,run,cold_start_s,total_time_s,cpu_time_s,peak_rss_bytes,output_size_bytes,duration_s,frame_count,effective_fps\n" > "$RESULTS_CSV"
printf "impl\tcold_start_s\tavg_total_s\tavg_cpu_s\tpeak_rss_bytes\tavg_output_size_bytes\tavg_effective_fps\n" > "$SUMMARY_TSV"

run_impl() {
  local impl="$1"
  shift

  local sum_total="0"
  local sum_cpu="0"
  local sum_size="0"
  local sum_eff="0"
  local max_rss_bytes=0
  local cold_start=""
  local run=1

  while [[ "$run" -le "$RUNS" ]]; do
    local output="$OUT_DIR/${impl}-run${run}.mp4"
    local logfile="$OUT_DIR/${impl}-run${run}.log"
    local timefile="$OUT_DIR/${impl}-run${run}.time"
    rm -f "$output" "$logfile" "$timefile"

    set +e
    /usr/bin/time -lp -o "$timefile" "$@" \
      --url "$URL" \
      --output "$output" \
      --duration "$DURATION" \
      --width "$WIDTH" \
      --height "$HEIGHT" \
      --fps "$FPS" \
      --chrome "$CHROME" \
      >"$logfile" 2>&1
    local status=$?
    set -e

    if [[ "$status" -ne 0 ]]; then
      echo "Run failed: ${impl} run ${run}. See $logfile" >&2
      exit 1
    fi

    local wall user sys rss_bytes cpu size_bytes duration_s frame_count eff_fps
    wall="$(awk '/^real /{print $2; exit}' "$timefile")"
    user="$(awk '/^user /{print $2; exit}' "$timefile")"
    sys="$(awk '/^sys /{print $2; exit}' "$timefile")"
    rss_bytes="$(awk '/maximum resident set size/{print $1; exit}' "$timefile")"
    cpu="$(awk -v u="$user" -v s="$sys" 'BEGIN { printf "%.6f", u + s }')"
    size_bytes="$(stat -f%z "$output")"
    duration_s="$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$output" | head -n 1)"
    frame_count="$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of default=noprint_wrappers=1:nokey=1 "$output" | head -n 1)"
    if [[ -z "$frame_count" || "$frame_count" == "N/A" ]]; then
      frame_count="0"
    fi
    eff_fps="$(awk -v f="$frame_count" -v d="$duration_s" 'BEGIN { if (d > 0) printf "%.6f", f / d; else print "0.000000" }')"

    if [[ "$run" -eq 1 ]]; then
      cold_start="$wall"
    fi

    sum_total="$(awk -v a="$sum_total" -v b="$wall" 'BEGIN { printf "%.6f", a + b }')"
    sum_cpu="$(awk -v a="$sum_cpu" -v b="$cpu" 'BEGIN { printf "%.6f", a + b }')"
    sum_size="$(awk -v a="$sum_size" -v b="$size_bytes" 'BEGIN { printf "%.6f", a + b }')"
    sum_eff="$(awk -v a="$sum_eff" -v b="$eff_fps" 'BEGIN { printf "%.6f", a + b }')"
    if [[ "$rss_bytes" -gt "$max_rss_bytes" ]]; then
      max_rss_bytes="$rss_bytes"
    fi

    printf "%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n" \
      "$impl" "$run" "$cold_start" "$wall" "$cpu" "$rss_bytes" "$size_bytes" "$duration_s" "$frame_count" "$eff_fps" \
      >> "$RESULTS_CSV"

    run=$((run + 1))
  done

  local avg_total avg_cpu avg_size avg_eff
  avg_total="$(awk -v s="$sum_total" -v n="$RUNS" 'BEGIN { printf "%.6f", s / n }')"
  avg_cpu="$(awk -v s="$sum_cpu" -v n="$RUNS" 'BEGIN { printf "%.6f", s / n }')"
  avg_size="$(awk -v s="$sum_size" -v n="$RUNS" 'BEGIN { printf "%.2f", s / n }')"
  avg_eff="$(awk -v s="$sum_eff" -v n="$RUNS" 'BEGIN { printf "%.6f", s / n }')"

  printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
    "$impl" "$cold_start" "$avg_total" "$avg_cpu" "$max_rss_bytes" "$avg_size" "$avg_eff" \
    >> "$SUMMARY_TSV"
}

echo "Running Node benchmark (${RUNS} runs)..."
run_impl "node" "$NODE_BIN" "$NODE_SCRIPT"

echo "Running Rust benchmark (${RUNS} runs)..."
run_impl "rust" "$RUST_BIN"

{
  echo "# Recorder Performance Summary"
  echo
  echo "- Runs per implementation: $RUNS"
  echo "- Duration per run: ${DURATION}s"
  echo "- Resolution: ${WIDTH}x${HEIGHT} @ ${FPS}fps"
  echo "- Chrome binary: \`$CHROME\`"
  echo
  echo "| Impl | Cold Start (s) | Avg Total (s) | Avg CPU (s) | Peak RSS (MiB) | Avg Output (KiB) | Avg Effective FPS |"
  echo "|---|---:|---:|---:|---:|---:|---:|"
  awk -F '\t' 'NR>1 {
    peak_mib = $5 / 1048576.0
    avg_kib = $6 / 1024.0
    printf "| %s | %.3f | %.3f | %.3f | %.2f | %.2f | %.3f |\n", $1, $2, $3, $4, peak_mib, avg_kib, $7
  }' "$SUMMARY_TSV"
  echo
  echo "Raw run-level metrics: \`$RESULTS_CSV\`"
} > "$SUMMARY_MD"

echo "Benchmark complete."
echo "Summary: $SUMMARY_MD"
echo "Raw CSV: $RESULTS_CSV"
