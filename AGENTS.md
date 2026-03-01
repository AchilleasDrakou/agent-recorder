# Agent Video Recorder (Core)

Record headless browser sessions to MP4 for visual QA.

## Default Agent Path

If not installed yet:

```bash
curl -fsSL https://raw.githubusercontent.com/AchilleasDrakou/agent-recorder/main/install.sh | bash
```

Before:

```bash
node ./scripts/agent-proof.mjs \
  --url "http://localhost:3000/page" \
  --mode before \
  --name pricing-cta
```

After:

```bash
node ./scripts/agent-proof.mjs \
  --url "http://localhost:3000/page" \
  --mode after \
  --name pricing-cta
```

The wrapper writes:
- `<video>.mp4`
- `<video>.mp4.proof.json`

## Dynamic Spec Mode

Prefer `--spec` for interaction flows:

```json
{
  "url": "https://preview.example.com/pricing",
  "mode": "after",
  "name": "pricing-cta",
  "profile": "efficient",
  "pace": "cinematic",
  "goal": "Validate CTA visibility and click path after redesign",
  "assertions": [
    {"type": "text_visible", "value": "Start free trial"},
    {"type": "clickable", "value": "primary CTA"}
  ],
  "actions": [
    {"type": "hover", "selector": "[data-testid='hero-cta']", "hoverMs": 600},
    {"type": "click", "selector": "[data-testid='hero-cta']"},
    {"type": "type", "selector": "#email", "text": "qa@example.com"},
    {"type": "press", "selector": "#email", "key": "Enter"},
    {"type": "wait_for", "containsText": "Thanks for signing up"}
  ],
  "duration": 10
}
```

Run:

```bash
node ./scripts/agent-proof.mjs --spec ./proof-spec.json
```

## Practical Rules

1. Record both `before` and `after` for UI changes.
2. Keep videos short (`5-15s`) unless the flow is long.
3. Prefer `--spec` with `actions` over custom scripts.
4. Use explicit `hover` action if you need hover states visible in video.
5. Return both artifact paths in output.
