# Changelog

All notable changes to this package will be documented in this file.

## [Unreleased]

### Added
- Supervisor ops now include `read_unified_log`, which aggregates team messages, supervisor score logs, help-request events, and trace events into one ordered stream for faster incident debugging.
- Added a hardened `restart_daemon` flow with graceful shutdown, SIGKILL fallback, health recheck, and dedicated regression tests.
- Added API/session reconnect regression coverage so websocket reconnect lifecycle remains protected by tests.

### Changed
- Pre-commit now serializes `prerecommit` runs and is pinned to `Node 22` with a `10GB` heap allocation to avoid multi-agent `tsc` OOM failures on shared machines.
- Updated the bundled Claude Code SDK to `2.1.85` and aligned the Codex bridge compatibility target documentation to `codex-cli 0.117.0`.

### Fixed
- Run-envelope identity resolution now prefers runtime-reported candidate identity and runtime fallback metadata before local derivation.
- Candidate identity no longer trusts stray `.genome` snapshots from an arbitrary shared repo/workspace; only trusted materialized workspaces may contribute specimen identity.
- Help-lane retries no longer treat saturated help-agent reuse as delivered work; pending actions now stay open until acceptance/activation is observable.
- Context status now derives Claude 1M window size from `resolvedModel` instead of stale persisted session metadata.

## [1.0.10] - 2026-04-12

### Fixed
- `org-manager` no longer crashes during team bootstrap when a legacy genome is missing `systemPrompt`; runtime now falls back to compatible instruction synthesis instead of aborting after team artifact fetch.
- Async team initialization failures in `runClaude` are now caught and reported locally instead of surfacing as a process-killing unhandled rejection.
- Fatal error logging now serializes `Error` objects with message and stack so daemon/session crash logs no longer collapse to `{}`.

## [2.0.16] - 2026-03-26

### Fixed
- Daemon `spawn-session` requests now return immediately when Claude slots are saturated instead of holding the RPC open until the 30s timeout.
- Supervisor termination now treats task-summary fetch failures as unknown state instead of incorrectly marking active teams terminated.
- Genome compare / rollback flows no longer depend on missing genome-hub routes; CLI now uses existing version endpoints and publishes valid next versions.

### Changed
- Mutated genomes now publish as the next version of the same genome instead of a detached `-mutation-*` fork.
- Published docs, support links, and default service URLs remain standardized on `aha-agi.com`.
- Existing web team-creation flow now retries the first machine RPC race automatically and treats prompt-mode `org-manager` as a bypass bootstrap seed instead of a persistent roster member.

## [2.0.15] - 2026-03-26

### Changed
- Removed npm package metadata links that still pointed to `slopus` repositories and issue trackers.
- Standardized published docs, support links, and bundled CLI help output on `https://github.com/Shiyao-Huang/aha/issues/new/choose`.
- Replaced remaining published `top1vibe.com` references with `aha-agi.com`.
- Aligned source defaults with published defaults for API, web app, and genome hub URLs.

## [2.0.12] - 2026-03-24

### Added
- WeChat bridge commands for cross-platform team messaging.
- Corps publication diagnostics: `createCorpsTemplate` API method with connection hints and auth error guidance on genome-hub publish failures.
- `aha-v4` bin alias for forward compatibility.

### Changed
- Default URLs standardized on `aha-agi.com` (`DEFAULT_SERVER_URL`, `DEFAULT_WEBAPP_URL`, `DEFAULT_GENOME_HUB_URL`).
- All scattered `localhost:3006` genome-hub fallbacks replaced with `DEFAULT_GENOME_HUB_URL` constant.

### Fixed
- Improved error messages on genome-hub publish failure — now surfaces connection hint and auth hint alongside the HTTP status.

## [2.0.1] - 2026-03-22

### Added
- Published the v3 CLI as a separate npm package (`cc-aha-cli-v3`) with dedicated `aha-v3` / `kanban-v3` binaries and `~/.aha-v3` home directory.
- Added auth recovery flows for reconnecting the current account and restoring a known account from a backup key.
- Added `aha-v3 sessions` and expanded `aha-v3 agents` management for archive/delete/show/update workflows.
- Added agent runtime materialization support for `aha-v3 agents spawn <file.agent.json>` plus bundled schema/examples.

### Changed
- Consolidated npm package documentation around the maintained v3 CLI reference and auth recovery guides.
- Updated npm package metadata to ship the release docs, examples, schema, and explicit Node 22+ engine requirement.

### Fixed
- Corrected package documentation to match the current default API URL, web app URL, command name, and home directory used by the v3 CLI.
