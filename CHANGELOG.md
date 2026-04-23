# Changelog

All notable changes to this package will be documented in this file.

## [Unreleased]

## [1.0.0] - 2026-04-09

This is the first public open-source release of aha-cli. The codebase has been cleaned, licensed, and prepared for community contribution.

### Added
- **Internationalization (i18n)**: Auto locale detection (`LANG` env / `Intl.DateTimeFormat`) with EN and ZH language packs. All user-visible strings in `src/commands/`, `src/ui/`, and `src/daemon/` migrated to `t()` calls. Runtime language switching supported.
- **Open source community files**: `LICENSE` (MIT), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`.
- **CI/CD pipeline**: GitHub Actions workflow for `npm run build`, `tsc`, and `vitest` on every push and pull request.
- **Prebuild protection**: `prebuild-warn` script warns when cold build (`npm run build`) is about to invalidate live chunk hashes and kill running agent sessions.
- **Agent skills**: `context-mirror` and `aha-v3-reference` skills bundled in `skills/`.
- **Supervisor ops**: `read_unified_log` aggregates team messages, supervisor score logs, help-request events, and trace events into one ordered stream for faster incident debugging.
- **Restart daemon**: Hardened `restart_daemon` flow with graceful shutdown, SIGKILL fallback, health recheck, and dedicated regression tests.
- **Session reconnect tests**: API/session reconnect regression coverage protecting websocket reconnect lifecycle.
- **Agent self-awareness**: `get_team_info` now includes genome responsibilities and role mirror for each roster member.
- **Team queue visibility**: `todoAssignedToOthers` field in `teamStats` prevents duplicate pickup of already-claimed tasks.

### Changed
- **Brand cleanup**: All references to legacy package names, deployment hosts, and upstream repository metadata replaced with `aha` / `aha-agi.com`. README updated with current architecture and setup instructions.
- **Obfuscation default**: `npm publish` obfuscation now defaults to `none` for open-source distribution.
- **Pre-commit**: Serialized `prerecommit` runs pinned to Node 22 with a 10 GB heap to avoid multi-agent `tsc` OOM on shared machines.
- **Claude Code SDK**: Updated to `2.1.85`; Codex bridge compatibility target documented as `codex-cli 0.117.0`.
- **URL constants**: All default URLs standardized on `aha-agi.com` (`DEFAULT_SERVER_URL`, `DEFAULT_WEBAPP_URL`, `DEFAULT_GENOME_HUB_URL`).

### Fixed
- **DNS fallback**: macOS systems with empty system DNS now fall back to Google/Cloudflare resolvers via a global `dns.lookup` patch installed at CLI entry.
- **Security**: Removed tracked `.env` files; `.gitignore` updated to exclude all secret-bearing files.
- **Run-envelope identity**: Prefers runtime-reported candidate identity and runtime fallback metadata before local derivation.
- **Candidate identity**: No longer trusts stray `.genome` snapshots from arbitrary workspaces; only trusted materialized workspaces contribute specimen identity.
- **Help-lane retries**: No longer treat saturated help-agent reuse as delivered work; pending actions stay open until observable acceptance/activation.
- **Context status**: Derives Claude 1M window size from `resolvedModel` instead of stale persisted session metadata.
- **AGENTS.md discovery**: Walks from `cwd` to repo root to preserve closest-scope docs.
- **Legion session env**: Full cleanup of session-scoped `AHA_*` env vars before daemon spawn.
- **Team pulse**: Deduplicated by `sessionId` to prevent ghost roster entries.
- **Archive/retire**: `archive_session` and `retire_self` now correctly remove the member from the team roster.

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
- Removed npm package metadata links that still pointed to legacy upstream repositories and issue trackers.
- Standardized published docs, support links, and bundled CLI help output on `https://github.com/Shiyao-Huang/aha/issues/new/choose`.
- Replaced remaining published legacy deployment-host references with `aha-agi.com`.
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
