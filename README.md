# Agent Recorder (Core)

Headless browser video recorder for visual QA.

Core scope:
- `agent-proof` for agent-driven recordings
- `cinematic` pace by default
- visible mouse cursor + click pulse by default
- actions-based interaction (`click`, `hover`, `type`, `press`, `scroll`, `wait`)

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/AchilleasDrakou/agent-recorder/main/install.sh | bash
```

Installed commands:
- `agent-recorder`
- `agent-proof`

## Quick Start

```bash
node ./scripts/agent-proof.mjs \
  --url "http://localhost:3000" \
  --mode after \
  --name homepage
```

## Action-Driven Recording

Use a spec file for interactive flows:

```json
{
  "url": "https://example.com",
  "mode": "after",
  "name": "signup-flow",
  "profile": "efficient",
  "pace": "cinematic",
  "actions": [
    { "type": "click", "selector": "#email" },
    { "type": "type", "selector": "#email", "text": "qa@example.com" },
    { "type": "type", "selector": "#password", "text": "secret-pass" },
    { "type": "hover", "selector": "button[type='submit']", "hoverMs": 600 },
    { "type": "click", "selector": "button[type='submit']" },
    { "type": "wait_for", "containsText": "Welcome" }
  ]
}
```

Run:

```bash
node ./scripts/agent-proof.mjs --spec ./proof-spec.json
```

## Defaults

Capture profiles:
- `default` = `1280x720 @ 10fps`, `jpeg-quality 90`
- `smooth` = `1280x720 @ 15fps`, `jpeg-quality 82`
- `efficient` = `960x540 @ 15fps`, `jpeg-quality 78`

Interaction pace:
- `fast`
- `normal`
- `cinematic` (default)

Cursor overlay:
- enabled by default in live recordings
- disable with `--cursor-overlay false`

## Live Control (Underlying Runtime)

The current `agent-proof` behavior is powered by live browser control via Puppeteer.

Direct command (optional):

```bash
node ./scripts/agent-proof-live.mjs \
  --url "https://example.com" \
  --actions @./examples/actions/login.actions.json \
  --pace cinematic \
  --duration 10
```

## Direct Rust Recorder (Fallback)

```bash
./target/debug/agent-recorder \
  --url "http://localhost:3000/page" \
  --output ./proof.mp4 \
  --duration 8 \
  --width 1280 \
  --height 720 \
  --fps 10 \
  --encoder auto \
  --jpeg-quality 90
```

## Requirements

- Rust 1.89+
- Node.js 20+
- Chrome/Chromium
- FFmpeg

## Testing

```bash
cargo test
```
