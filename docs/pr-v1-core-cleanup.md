# PR: Simplify to V1 Core Recorder Surface

## Why
This PR reduces maintenance overhead and removes feature branches/paths we are not actively shipping. The result is a tighter core focused on the production workflow: action-driven recordings with cinematic pacing and visible cursor by default.

## What Changed
- Kept core runtime:
  - Rust recorder (`src/main.rs`)
  - Live browser controller (`scripts/agent-proof-live.mjs`)
- Added internal capture script:
  - `scripts/agent-capture.mjs`
- Simplified CLI:
  - `scripts/agent-proof.mjs` is now a thin core wrapper.
- Updated docs and install script:
  - `README.md`, `AGENTS.md`, `CLAUDE.md`, `install.sh`
- Removed non-core/experimental scripts:
  - server mode, autoplan mode, benchmark helper, legacy test harness, site-specific scripts.

## User Impact
- Default behavior remains aligned with current preferred UX:
  - `pace=cinematic`
  - cursor overlay visible
- Public CLI is narrower:
  - `--script` and direct `--ws-endpoint` are no longer supported on `agent-proof`.

## Validation
- `bash -n install.sh`
- `node --check` on updated scripts
- Smoke run: no-action capture via `agent-proof`
- Smoke run: action flow capture via `agent-proof` (Saucedemo)
- Verified sidecar and MP4 outputs

## Follow-up (after merge)
- Tag release and push tag.
- Optionally publish short migration note in release description.
