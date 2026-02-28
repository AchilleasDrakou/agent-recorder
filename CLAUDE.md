# Agent Video Recorder — Claude/Codex Usage

Use this repository to produce visual QA proofs of UI work.

## Preferred Workflow

Install once:

```bash
curl -fsSL https://raw.githubusercontent.com/AchilleasDrakou/agent-recorder/main/install.sh | bash
```

Use the wrapper tool:

```bash
node ./scripts/agent-proof.mjs --spec ./proof-spec.json
```

or:

```bash
node ./scripts/agent-proof.mjs \
  --url "http://localhost:3000/page" \
  --mode before \
  --name feature-x
```

After implementing changes:

```bash
node ./scripts/agent-proof.mjs \
  --url "http://localhost:3000/page" \
  --mode after \
  --name feature-x
```

## Why This Path

- Single stable command for agents.
- Uses the Rust recorder underneath.
- Emits both video and machine-readable metadata (`.proof.json`).
- Lower token usage than generating long ad-hoc scripts for every task.

## API Mode (for tool-calling agents)

Start server:

```bash
export AGENT_PROOF_API_TOKEN="replace-me"  # optional but recommended
node ./scripts/agent-proof-server.mjs --port 8788
```

Submit run:

```bash
curl -sS -X POST "http://127.0.0.1:8788/proof-runs" \
  -H "authorization: Bearer $AGENT_PROOF_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "spec": {
      "url": "http://localhost:3000/page",
      "mode": "after",
      "name": "feature-x"
    }
  }'
```

Poll:

```bash
curl -sS -H "authorization: Bearer $AGENT_PROOF_API_TOKEN" \
  "http://127.0.0.1:8788/proof-runs/<run-id>"
```

Cancel:

```bash
curl -sS -X DELETE -H "authorization: Bearer $AGENT_PROOF_API_TOKEN" \
  "http://127.0.0.1:8788/proof-runs/<run-id>"
```

## Spec Contract

Recommended fields:

```json
{
  "url": "https://preview.example.com",
  "mode": "after",
  "name": "signup-flow",
  "goal": "Validate signup CTA and redirect behavior",
  "assertions": [{"type":"url_contains","value":"/signup"}],
  "duration": 10,
  "width": 1280,
  "height": 720,
  "fps": 10,
  "encoder": "auto",
  "script": "./scripts/custom-interactions.js"
}
```

## Interaction Guidance

- Default to pure capture first.
- Use `script` only when the flow requires interactions.
- Keep scripts task-specific and short.

## Required Deliverables in Agent Output

1. Before video path
2. After video path
3. Sidecar JSON path(s)
4. One-sentence summary of what was visually validated
