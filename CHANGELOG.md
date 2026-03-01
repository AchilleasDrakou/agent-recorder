# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## [v1-core-cleanup] - 2026-03-01

### Added
- Added internal capture runner `scripts/agent-capture.mjs` for a leaner live-control recording path.
- Added core-focused docs for `agent-proof` defaults and action-driven usage.

### Changed
- Simplified `agent-proof` into a thin core wrapper around live-control mode.
- Kept `cinematic` pacing and cursor overlay as default recording behavior.
- Updated installer to install only `agent-recorder` and `agent-proof` wrappers.
- Updated documentation to reflect a core-only surface area.

### Fixed
- Fixed a live-control deadlock where the recorder child process could exit before listener attachment.

### Removed
- Removed experimental and non-core tooling:
  - `scripts/agent-proof-autoplan.mjs`
  - `scripts/agent-proof-server.mjs`
  - `scripts/test-ab-core.sh`
  - `scripts/benchmark-side-by-side.sh`
  - site-specific helper scripts and autoplan example spec
