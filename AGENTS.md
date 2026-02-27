# Agent Video Recorder

Record headless browser sessions to MP4 for visual QA. Before/after videos prove your work actually works.

## Quick Start

```bash
node ~/tools/agent-recorder/record.mjs \
  --url "http://localhost:3000" \
  --output ./recording.mp4 \
  --duration 10
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--url` | required | URL to record |
| `--output` | `recording.mp4` | Output file path |
| `--duration` | `10` | Seconds to record |
| `--width` | `1280` | Viewport width |
| `--height` | `720` | Viewport height |
| `--fps` | `10` | Frames per second |
| `--script` | none | JS file to run during recording |
| `--chrome` | `/usr/bin/chromium` | Chrome/Chromium path |

## Before/After Pattern

For every UI task, record two videos:

```bash
# 1. Record BEFORE state
node ~/tools/agent-recorder/record.mjs \
  --url "http://localhost:3000/page" \
  --output ./before.mp4 \
  --duration 5

# 2. Make your changes, deploy to preview

# 3. Record AFTER state
node ~/tools/agent-recorder/record.mjs \
  --url "http://localhost:3000/page" \
  --output ./after.mp4 \
  --duration 5
```

Attach both to the PR description.

## Interactive Recording

For login flows, form submissions, or click-throughs — write a Puppeteer script:

```bash
node ~/tools/agent-recorder/record.mjs \
  --url "http://localhost:3000/login" \
  --output ./login-flow.mp4 \
  --duration 15 \
  --script ./login-actions.js
```

The `--script` JS runs inside the page via `page.evaluate()`. For complex flows, write a custom recorder script (see `demo-login.mjs` for an example).

## Requirements

- Node.js 20+
- Chromium (`/usr/bin/chromium` or specify `--chrome`)
- FFmpeg

## How It Works

1. Launches headless Chromium
2. Uses CDP `Page.startScreencast` to capture JPEG frames
3. Pipes frames to FFmpeg which encodes to H.264 MP4
4. Triggers minor repaints to ensure consistent frame capture on static pages

## Output

- Format: H.264 MP4 (yuv420p)
- Typical size: ~20KB/sec at 720p 10fps
- No audio (Chrome screencast limitation)
