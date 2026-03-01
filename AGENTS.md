# Agent Video Recorder

Record headless browser sessions to MP4 for visual QA. Use this as proof that UI changes actually work.

## Default Agent Path

If not installed yet:

```bash
curl -fsSL https://raw.githubusercontent.com/AchilleasDrakou/agent-recorder/main/install.sh | bash
```

Use the thin agent wrapper:

```bash
node ./scripts/agent-proof.mjs \
  --url "http://localhost:3000/page" \
  --mode before \
  --name pricing-cta
```

Then after changes:

```bash
node ./scripts/agent-proof.mjs \
  --url "http://localhost:3000/page" \
  --mode after \
  --name pricing-cta
```

The wrapper runs the Rust recorder, writes an MP4, and writes a sidecar JSON (`.proof.json`) with run metadata and ffprobe metrics.

## Local API (curl-friendly)

Start server:

```bash
export AGENT_PROOF_API_TOKEN="replace-me"  # optional but recommended
node ./scripts/agent-proof-server.mjs --port 8788
```

Create a run:

```bash
curl -sS -X POST "http://127.0.0.1:8788/proof-runs" \
  -H "authorization: Bearer $AGENT_PROOF_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "spec": {
      "url": "http://localhost:3000/page",
      "mode": "after",
      "name": "pricing-cta",
      "duration": 8
    }
  }'
```

Poll run status:

```bash
curl -sS -H "authorization: Bearer $AGENT_PROOF_API_TOKEN" \
  "http://127.0.0.1:8788/proof-runs/<run-id>"
```

Cancel a queued/running run:

```bash
curl -sS -X DELETE -H "authorization: Bearer $AGENT_PROOF_API_TOKEN" \
  "http://127.0.0.1:8788/proof-runs/<run-id>"
```

Health:

```bash
curl -sS "http://127.0.0.1:8788/health"
```

## Dynamic Spec Mode

Prefer `--spec` for agentic workflows:

```json
{
  "url": "https://preview.example.com/pricing",
  "mode": "after",
  "name": "pricing-cta",
  "profile": "efficient",
  "goal": "Validate CTA visibility and click path after redesign",
  "assertions": [
    {"type": "text_visible", "value": "Start free trial"},
    {"type": "clickable", "value": "primary CTA"}
  ],
  "actions": [
    {"type": "click", "selector": "[data-testid='hero-cta']"},
    {"type": "type", "selector": "#email", "text": "qa@example.com"},
    {"type": "press", "selector": "#email", "key": "Enter"},
    {"type": "wait_for", "containsText": "Thanks for signing up"}
  ],
  "duration": 10
}
```

Run it:

```bash
node ./scripts/agent-proof.mjs --spec ./proof-spec.json
```

Notes:
- `goal` and `assertions` are preserved in the sidecar file for downstream agent/reporting logic.
- `actions` is built in for generic interaction flows; only use `--script` for edge cases.
- Profiles: `default` (`1280x720 @ 10fps`), `smooth` (`1280x720 @ 15fps`), `efficient` (`960x540 @ 15fps`).

## Direct Recorder (Fallback)

If needed, run the Rust binary directly:

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

## Practical Rules

1. Record both `before` and `after` for UI changes.
2. Keep videos short (`5-15s`) unless the flow is long.
3. Prefer spec-driven runs for token efficiency.
4. Use `--script` only when interaction is necessary.
5. Return both artifact paths in agent output:
- `<video>.mp4`
- `<video>.mp4.proof.json`
