# Agent Recorder (Rust)

Headless browser video recorder for AI QA workflows. It records a page to MP4 using Chrome DevTools Protocol screencast frames piped into FFmpeg.

Started as a Node.js recorder, then we rebuilt the core in Rust for better performance, and added thin agent wrappers (`agent-proof` CLI + local API) on top.

## Install (agent-friendly)

One-liner (local setup):

```bash
curl -fsSL https://raw.githubusercontent.com/AchilleasDrakou/agent-recorder/main/install.sh | bash
```

This installs:
- `agent-recorder`
- `agent-proof`
- `agent-proof-server`

Install script source: `./install.sh`

## Quick start

```bash
cargo run -- \
  --url "http://localhost:3000" \
  --output ./recording.mp4 \
  --duration 10
```

Agent-friendly wrapper:

```bash
node ./scripts/agent-proof.mjs \
  --url "http://localhost:3000" \
  --mode after \
  --name homepage \
  --pace cinematic
```

## Action-driven recordings (no custom script required)

`agent-proof` supports an `actions` array in `--spec` (or `--actions @file.json`) so agents can click/type/press/scroll dynamically without writing per-page scripts.

Example:

```json
{
  "url": "https://example.com",
  "mode": "after",
  "name": "signup-flow",
  "profile": "efficient",
  "actions": [
    { "type": "click", "selector": "#email" },
    { "type": "type", "selector": "#email", "text": "qa@example.com" },
    { "type": "type", "selector": "#password", "text": "secret-pass" },
    { "type": "click", "selector": "button[type='submit']" },
    { "type": "wait_for", "containsText": "Welcome" }
  ]
}
```

Supported actions:
- `wait`
- `wait_for`
- `click`
- `type`
- `press`
- `focus`
- `hover`
- `scroll_by`
- `scroll_to`
- `toggle`
- `select`
- `evaluate`

FPS/performance profiles:
- `default` = `1280x720 @ 10fps`, `jpeg-quality 90`
- `smooth` = `1280x720 @ 15fps`, `jpeg-quality 82`
- `efficient` = `960x540 @ 15fps`, `jpeg-quality 78`

Interaction pace presets:
- `fast` = low delay, useful for smoke checks
- `normal` = balanced, smoother and human-like
- `cinematic` = slower, more watchable demos (default)

## Live Browser Control Mode (Puppeteer)

For complex multi-step browsing, use live control (external browser controller + recorder attached to same page via CDP):

```bash
node ./scripts/agent-proof-live.mjs \
  --url "https://example.com" \
  --actions @./examples/actions/login.actions.json \
  --pace cinematic \
  --duration 10
```

This mode executes actions with Puppeteer in real time and records the same session as MP4.
It shows a high-contrast virtual cursor + click ripple overlay by default in recordings.
Disable with `--cursor-overlay false` if needed.

## AutoPlanner (Experimental)

AutoPlanner is available but intentionally gated as experimental.

```bash
node ./scripts/agent-proof-autoplan.mjs \
  --spec ./examples/actions/autoplan-login.spec.json \
  --autoplan-experimental true
```

You can also enable it via environment variable:

```bash
AGENT_PROOF_ENABLE_AUTOPLAN=1 node ./scripts/agent-proof-autoplan.mjs --spec ./autoplan-spec.json
```

## Requirements

- Rust 1.89+
- Chrome/Chromium
- FFmpeg

## CLI options

```bash
cargo run -- \
  --url <url> \
  --output <file.mp4> \
  --duration <seconds> \
  --width <px> \
  --height <px> \
  --fps <n> \
  --chrome <path> \
  --ffmpeg <path> \
  --encoder <name|auto> \
  --video-bitrate <rate> \
  --maxrate <rate> \
  --bufsize <rate> \
  --jpeg-quality <1-100> \
  --script <file.js>
```

- `--url` (required)
- `--output` default `recording.mp4`
- `--duration` default `10`
- `--width` default `1280`
- `--height` default `720`
- `--fps` default `10`
- `--chrome` default `/usr/bin/chromium`
- `--ffmpeg` default `ffmpeg`
- `--encoder` default `auto` (macOS prefers `h264_videotoolbox`)
- `--video-bitrate` optional target bitrate (e.g. `1200k`)
- `--maxrate` optional max bitrate for hardware encoders
- `--bufsize` optional encoder buffer size for hardware encoders
- `--jpeg-quality` default `90`
- `--script` optional JS evaluated on the page
- `--ws-endpoint` optional existing CDP websocket endpoint (useful for tests)

## Testing

```bash
cargo test
```

Includes an end-to-end integration test with a mocked CDP websocket + fake ffmpeg process.

## Performance (Node vs Rust)

Side-by-side benchmark run with `scripts/benchmark-side-by-side.sh`:

- Runs per implementation: `5`
- Duration per run: `3s`
- Resolution: `640x360 @ 8fps`
- Chrome binary: `Chromium 147.0.7708.0`

| Impl | Cold Start (s) | Avg Total (s) | Avg CPU (s) | Peak RSS (MiB) | Avg Output (KiB) | Avg Effective FPS |
|---|---:|---:|---:|---:|---:|---:|
| node | 6.050 | 5.972 | 1.772 | 199.11 | 5.29 | 8.000 |
| rust | 4.420 | 4.180 | 0.782 | 198.36 | 5.48 | 8.000 |
