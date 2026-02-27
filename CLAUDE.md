# Agent Video Recorder — Instructions for Claude Code / Codex

You have access to a video recording tool at `~/tools/agent-recorder/`. Use it to visually validate UI changes.

## When to Record

- Any task that changes UI (new components, layout changes, styling)
- Bug fixes with visual symptoms
- New pages or flows

## How to Record

### Simple page capture
```bash
node ~/tools/agent-recorder/record.mjs \
  --url "http://localhost:3000/your-page" \
  --output ./proof.mp4 \
  --duration 8
```

### With interactions (login, forms, navigation)

Write a custom script. Copy `~/tools/agent-recorder/demo-login.mjs` as a template:

```javascript
import puppeteer from 'puppeteer-core';
import { spawn } from 'child_process';

// Key pattern:
// 1. Launch browser + FFmpeg
// 2. Start CDP screencast
// 3. Navigate + interact (type, click, scroll, wait)
// 4. Stop screencast + close FFmpeg
```

The demo shows: launch → navigate → type password → click submit → wait for dashboard → scroll → save.

## Rules

1. **Always record BEFORE making changes** if the page already exists
2. **Record AFTER** once changes are deployed to preview/local
3. **Name files clearly**: `before-feature-name.mp4`, `after-feature-name.mp4`
4. **Keep recordings short** — 5-15 seconds is enough
5. **Attach to PR description** with a note on what changed
6. **10fps is fine** — this is for QA, not production video

## Dev Server

Start the app's dev server before recording:
```bash
cd /path/to/project && npm run dev &
sleep 5  # wait for server
node ~/tools/agent-recorder/record.mjs --url http://localhost:3000 ...
```

## Auth / Cookies

If the app requires auth, write a custom script that:
1. Navigates to login page
2. Fills credentials
3. Submits
4. Then records the authenticated pages

Or set the auth cookie directly:
```javascript
await page.setCookie({
  name: 'session',
  value: 'your-token',
  domain: 'localhost',
});
await page.goto('http://localhost:3000/dashboard');
```

## Troubleshooting

- **0 or 1 frame**: Static page — the recorder forces repaints, but if you get low frames, increase `--duration`
- **Connection refused**: Dev server not running or wrong port
- **Black video**: Page might need longer to load — add a `waitUntil: 'networkidle2'` or increase initial wait
- **Chrome not found**: Pass `--chrome /path/to/chromium`
