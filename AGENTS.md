# Repository Guidelines

## ESM `.mjs` helper typing rule

Any newly added ESM `.mjs` helper must ship with matching declaration files in the same change.

- Required:
  - `scripts/lib/<name>.d.ts`
  - `scripts/lib/<name>.d.mts`
- Do not send a helper to review if its declarations are missing.
- Treat missing declarations as a repository-wide typecheck blocker, not a follow-up cleanup item.

## Pre-review checklist

Before marking work as `review`, the assignee must complete this checklist:

```bash
git status
npx vitest run <changed-spec>
# If full typecheck OOMs, run focused tsc / targeted file checks instead.
```

- `git status` must confirm there are no task-related unstaged or forgotten untracked files.
- Run targeted tests for the changed area and confirm they pass.
- Run focused `tsc` / targeted type checks to confirm there is no type regression.
- If the machine hits OOM, downgrade to a narrower file-level check, but do not skip type validation entirely.
