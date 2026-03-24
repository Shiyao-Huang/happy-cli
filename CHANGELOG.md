# Changelog

All notable changes to this package will be documented in this file.

## [2.0.12] - 2026-03-24

### Added
- WeChat bridge commands for cross-platform team messaging.
- Corps publication diagnostics: `createCorpsTemplate` API method with connection hints and auth error guidance on genome-hub publish failures.
- `aha-v4` bin alias for forward compatibility.

### Changed
- Default URLs migrated from `top1vibe.com` to `aha-agi.com` (`DEFAULT_SERVER_URL`, `DEFAULT_WEBAPP_URL`, `DEFAULT_GENOME_HUB_URL`).
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
