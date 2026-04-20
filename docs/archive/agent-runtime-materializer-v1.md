# Agent Runtime Materializer v1

Date: 2026-03-18
Status: Draft

## 1. Purpose

The materializer does **not** patch SDK internals.

Its job is:

> given an `agent.json`, a repository path, and a workspace mode,
> create an agent-specific runtime workspace view that Claude/Codex can run from safely.

This is the missing layer between:

- `agent.json` (package/config declaration)
- runtime adapter (`runClaude.ts` / `runCodex.ts`)

## 2. Core Rule

The materializer owns:

- workspace layout
- per-agent settings materialization
- per-agent command visibility
- per-agent env materialization
- per-agent logs/cache/tmp paths

It does **not** own:

- score aggregation
- lineage mutation policy
- market ranking
- SDK-level behavior

## 3. Inputs

The materializer reads:

1. `agent.json`
2. repository root path
3. requested workspace mode (`shared` or `isolated`)
4. optional runtime-lib root
5. optional repo-local `.aha-config`
6. optional launch-time overrides

### 3.1 Logical input object

```ts
interface MaterializeAgentWorkspaceInput {
  agentId: string;
  repoRoot: string;
  workspaceMode: 'shared' | 'isolated';
  runtime: 'claude' | 'codex' | 'open-code';
  agentConfigPath: string;
  runtimeLibRoot?: string;
  launchOverrides?: {
    env?: Record<string, string>;
    allowedSkills?: string[];
  };
}
```

## 4. Outputs

The materializer produces a concrete runtime workspace view.

```ts
interface MaterializeAgentWorkspaceResult {
  agentId: string;
  workspaceRoot: string;
  effectiveCwd: string;
  settingsPath?: string;
  commandsDir?: string;
  mcpConfigPath?: string;
  envFilePath?: string;
  logsDir: string;
  cacheDir: string;
  tmpDir: string;
  cleanupHints: {
    workspaceMode: 'shared' | 'isolated';
    canDeleteWorkspace: boolean;
    canDeleteWorktree: boolean;
  };
}
```

## 5. Directory Layout

```text
.aha/
  runtime-lib/
    skills/
    mcp/
    hooks/
    prompts/

  runtime/
    <agent-id>/
      workspace/
        .claude/
          settings.json
          commands/
        .aha-agent/
          env.json
          mcp.json
      logs/
      cache/
      tmp/

  worktrees/
    <agent-id>/   # only for isolated mode
```

### 5.1 Meaning of each directory

- `runtime-lib/`
  - shared read-only public library
- `runtime/<agent-id>/`
  - agent instance state root
- `workspace/`
  - concrete runtime-visible working view
- `logs/`
  - per-agent runtime logs
- `cache/`
  - per-agent cache
- `tmp/`
  - temp files for that agent instance
- `worktrees/<agent-id>/`
  - optional isolated code working tree

## 6. Shared vs Isolated Mode

## 6.1 Shared mode

Use when:

- ordinary multi-agent team execution
- agent-specific differences can be expressed via per-process injection
- no per-agent code tree isolation required

### Shared mode rules

- project code stays shared
- runtime state stays per-agent
- public library resources may be linked in
- repo-local defaults may be linked or copied depending on mutability

### Shared mode effective cwd

Prefer:

- `effectiveCwd = repoRoot`

But the materializer still creates:

- per-agent `logs/`
- per-agent `cache/`
- per-agent `tmp/`

### Shared mode limitation

Different hooks do **not** automatically force isolated mode if they can be injected
per process (for example via process-specific settings input).

Shared mode becomes unsafe only when the required difference cannot be expressed via
per-process injection and would require mutating the shared workspace view itself.

Typical unsafe cases:

- mutating a shared project-level `.claude/settings.json`
- mutating a shared `.claude/commands/` visibility view
- requiring an isolated code working tree

In those cases the materializer must:

- auto-upgrade to `isolated`, or
- reject with a clear conflict error

## 6.2 Isolated mode

Use when:

- agent-specific hooks are required
- mutation experiments are running
- rollback comparison is needed
- per-agent command visibility differs materially
- independent code working view is needed

### Isolated mode rules

- code working tree is isolated
- runtime state is isolated
- `.claude/settings.json` is isolated
- `.claude/commands/` is isolated

### Isolated mode effective cwd

Prefer:

- `effectiveCwd = .aha/worktrees/<agent-id>/`

If worktree creation is not available, fallback may be:

- repo symlink / overlay strategy

But v1 should standardize around worktree-first semantics.

## 7. Resource Materialization Rules

## 7.1 Skills

### Shared source

Public, read-only skills live in:

```text
.aha/runtime-lib/skills/
```

### Materialization rule

- only skills declared in `tools.skills` become visible to the agent
- visibility is enforced by materializing only those skills into the agent's command view

### Recommended strategy

- shared source = read-only
- instance command view = symlink only selected skills

Example:

```text
.aha/runtime/<agent-id>/workspace/.claude/commands/review -> ../../../runtime-lib/skills/review
```

## 7.2 Hooks

Hook templates may be shared.

Effective hooks must be materialized per agent in:

```text
.aha/runtime/<agent-id>/workspace/.claude/settings.json
```

Reason:

- hooks are auto-triggered
- the safe default is per-agent effective settings materialization
- hook differences only become a shared-mode conflict if they must modify the same
  shared workspace-visible settings file

## 7.3 MCP

Split MCP into two layers:

- shared templates / definitions
- instance-specific effective config

Shared templates may live in:

```text
.aha/runtime-lib/mcp/
```

Effective config should be generated into:

```text
.aha/runtime/<agent-id>/workspace/.aha-agent/mcp.json
```

Secrets must remain instance-specific.

## 7.4 Env

Environment variables are never shared as mutable runtime state.

They should be materialized per instance into:

```text
.aha/runtime/<agent-id>/workspace/.aha-agent/env.json
```

or injected directly as process env at launch.

## 8. Link vs Copy Rules

### Link allowed

Use symlink / read-only bind-style semantics for:

- public skills
- public MCP templates
- read-only prompt templates
- read-only hook templates

### Copy/materialize required

Do not share mutable effective runtime files.

Must be copied/generated per instance:

- effective `settings.json`
- effective commands visibility view
- env materialization
- logs/cache/tmp
- secrets

## 9. Conflict Detection

The materializer must explicitly detect at least:

1. hook conflict
2. command visibility conflict
3. missing required env
4. missing shared library dependency
5. unsupported workspace mode

### 9.1 Hook conflict rule

If workspace mode is `shared` and the effective hook payload differs across agents for the same visible workspace:

- do not silently merge
- auto-upgrade to isolated, or reject

### 9.2 Skill conflict rule

If command visibility differs:

- shared mode may still be possible only if command visibility is not materialized into the shared `.claude/commands`
- if it must be materialized there, shared mode is unsafe

## 10. Lifecycle

### 10.1 Creation time

Materialization happens:

- on agent launch
- before runtime process starts

### 10.2 Cleanup time

#### Shared mode

- keep runtime logs/cache/tmp per retention policy
- workspace view may be reused

#### Isolated mode

- worktree may be retained for debugging / rollback inspection
- cleanup policy should be delayed, not immediate

### 10.3 Daemon restart recovery

The daemon should be able to reconstruct active runtime directories from:

- persisted agent/session metadata
- `.aha/runtime/<agent-id>/`

This implies runtime directories should be discoverable and stable enough for restart recovery.

## 11. Minimal v1 Implementation Scope

Do not try to solve everything at once.

### v1 should implement

1. schema and docs for workspace mode
2. runtime directory conventions
3. hooks -> per-agent settings materialization
4. env validation/materialization
5. logs/cache/tmp per-agent isolation

### v1 may defer

1. full isolated git worktree implementation
2. advanced overlay filesystem logic
3. automatic conflict auto-resolution
4. shared library package manager

## 12. Final Rule

The materializer is the right place to express Docker-like behavior.

Not:

- SDK patching
- session base-class mutation

But:

- per-agent runtime workspace generation
- shared read-only library mounting
- instance-scoped effective config materialization
