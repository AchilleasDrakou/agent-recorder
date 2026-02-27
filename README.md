# Agent Recorder

Lightweight headless browser video recorder built for AI agent QA. Records browser sessions to MP4 using Chrome DevTools Protocol screencast + FFmpeg.

**Built for agents, not humans.** Agents use this to visually prove their work — before/after videos of UI changes, login flows, form submissions.

## Why

Screenshots are static. Videos show the full story. When an AI agent makes UI changes, a 5-second video is worth more than a paragraph of explanation.

- **~20KB/sec** at 720p 10fps — tiny files, easy to attach to PRs
- **Headless** — no display needed, runs on any server
- **Simple** — one command, one dependency (puppeteer-core), uses system Chrome + FFmpeg

## Quick Start

```bash
git clone https://github.com/AchilleasDrakou/agent-recorder.git
cd agent-recorder && npm install

# Record any URL
node record.mjs --url "http://localhost:3000" --output demo.mp4 --duration 10
```

## Requirements

- Node.js 20+
- Chrome or Chromium
- FFmpeg

## Usage

```bash
node record.mjs \
  --url <url>           # URL to record (required)
  --output <file.mp4>   # Output path (default: recording.mp4)
  --duration <seconds>  # Recording duration (default: 10)
  --width <px>          # Viewport width (default: 1280)
  --height <px>         # Viewport height (default: 720)
  --fps <n>             # Frames per second (default: 10)
  --chrome <path>       # Chrome binary (default: /usr/bin/chromium)
  --script <file.js>    # JS to execute during recording
```

## Before/After Pattern

The main use case — visually validate UI changes:

```bash
# 1. Record before
node record.mjs --url http://localhost:3000/page --output before.mp4 --duration 5

# 2. Make changes, deploy

# 3. Record after
node record.mjs --url http://localhost:3000/page --output after.mp4 --duration 5

# 4. Attach both to PR
```

## Interactive Recording

For flows that require login, clicking, typing — write a custom Puppeteer script. See `demo-login.mjs` for an example that:

1. Navigates to a login page
2. Types a password
3. Submits the form
4. Records the authenticated dashboard
5. Scrolls through content

## How It Works

1. Launches headless Chromium via puppeteer-core
2. Starts CDP [`Page.startScreencast`](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast) to capture JPEG frames
3. Pipes frames to FFmpeg which encodes H.264 MP4
4. Forces minor repaints to ensure consistent frame capture on static pages

## Output

- **Format:** H.264 MP4 (yuv420p, faststart)
- **Size:** ~20KB/sec at 720p 10fps
- **No audio** (Chrome screencast limitation)

## Agent Docs

- `AGENTS.md` — Quick reference for any agent
- `CLAUDE.md` — Detailed instructions for Claude Code / Codex agents

## License

MIT
