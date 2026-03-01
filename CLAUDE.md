# Agent Video Recorder — Claude/Codex Usage (Core)

Use this repository to produce visual QA proof videos.

## Preferred Workflow

Install once:

```bash
curl -fsSL https://raw.githubusercontent.com/AchilleasDrakou/agent-recorder/main/install.sh | bash
```

Run with a spec:

```bash
node ./scripts/agent-proof.mjs --spec ./proof-spec.json
```

Or quick before/after:

```bash
node ./scripts/agent-proof.mjs \
  --url "http://localhost:3000/page" \
  --mode before \
  --name feature-x

node ./scripts/agent-proof.mjs \
  --url "http://localhost:3000/page" \
  --mode after \
  --name feature-x
```

## Core Defaults

- Cinematic pacing by default
- Visible cursor + click pulse by default
- Action-driven interaction support (`hover`, `click`, `type`, `press`, `scroll`, `wait`)

## Spec Contract

Recommended fields:

```json
{
  "url": "https://preview.example.com",
  "mode": "after",
  "name": "signup-flow",
  "goal": "Validate signup CTA and redirect behavior",
  "assertions": [{"type":"url_contains","value":"/signup"}],
  "profile": "efficient",
  "pace": "cinematic",
  "actions": [
    {"type": "hover", "selector": "button[type='submit']", "hoverMs": 600},
    {"type": "click", "selector": "button[type='submit']"},
    {"type": "wait_for", "containsText": "Welcome"}
  ],
  "duration": 10
}
```

## Required Deliverables in Agent Output

1. Before video path
2. After video path
3. Sidecar JSON path(s)
4. One-sentence summary of visual validation
