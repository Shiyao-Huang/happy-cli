# Bootstrap Operator

Use this when the running `aha-cli` daemon must be restarted onto a newer build without losing the recovery path.

## Purpose

- keep one stable outer operator while the main daemon changes
- restart the daemon onto a new build
- verify the new process is serving a new `buildHash`
- leave a handoff trail

## Preconditions

1. Confirm the target repo is the active `aha-cli` worktree.
2. Confirm `dist/` has already been rebuilt.
3. Confirm no other bootstrap is active (`.bootstrap.lock` absent).

## Canonical flow

```bash
cd /Users/copizza/Desktop/happyhere/aha-cli-0330-max-redefine-login
node bootstrap.mjs status
node bootstrap.mjs
node bootstrap.mjs status
```

## Contract surface

- daemon state file: `~/.aha/daemon.state.json` or `AHA_HOME_DIR/daemon.state.json`
- `GET /health`
- `GET /version`
- `buildHash` must change across restart when a new build was intended

## Success criteria

- new `pid != old pid`
- new `buildHash != old buildHash`
- handoff file written to `.aha/bootstrap-handoff.json`
- if `teamId` + token are configured, bootstrap also posts a team message

## Failure handling

- if `.bootstrap.lock` exists, stop and inspect before retrying
- if `/version` never reports a new build, treat the restart as failed even if the process is alive
- if the team message is skipped, the handoff file is still the source of truth
