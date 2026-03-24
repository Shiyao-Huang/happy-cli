# Agent Docker JSON v1

This document defines the first practical `agent.json` shape for Aha Agent Docker.

The goal of v1 is simple:

- one config file
- engine can read it
- runtime can launch from it
- supervisor knows how to evaluate it
- `genome-hub` can later bind score records to it

This is intentionally smaller than the long-term package model.

Important design stance:

- this JSON stays **flat**
- concept groups exist in the docs, but not as nested `config` / `runtime` / `market` sections
- Docker-like separation happens at the **workspace materialization layer**, not by forcing the JSON into artificial top-level buckets

## 1. Mental model

Think of `agent.json` as:

- the agent's config file
- the engine's launch input
- the evaluation contract anchor

It is **not**:

- the live runtime state
- the score result itself
- the aggregated market score

Those runtime and scoring results belong outside `agent.json`.

## 2. Example

```json
{
  "$schema": "../schemas/agent-json-v1.schema.json",
  "kind": "aha.agent.v1",
  "name": "supervisor",
  "description": "Team supervisor",
  "baseRoleId": "supervisor",
  "runtime": "claude",
  "prompt": {
    "suffix": "Review team progress and score agents."
  },
  "tools": {
    "allowed": ["read_team_log", "score_agent", "send_team_message"],
    "skills": ["ralph-loop-start", "ralph-loop-status"]
  },
  "permissions": {
    "permissionMode": "bypassPermissions",
    "accessLevel": "read-only",
    "executionPlane": "bypass",
    "maxTurns": 200
  },
  "context": {
    "teamRole": "supervisor",
    "capabilities": ["monitor_team", "score_agents"],
    "behavior": {
      "onIdle": "wait",
      "onBlocked": "escalate",
      "canSpawnAgents": false,
      "requireExplicitAssignment": false
    }
  },
  "env": {
    "required": [],
    "optional": ["AHA_ROOM_ID"]
  },
  "routing": {
    "strategy": "fixed",
    "models": {
      "default": "claude-sonnet-4-20250514",
      "reasoning": "claude-opus-4-20250514"
    }
  },
  "workspace": {
    "defaultMode": "shared",
    "allowedModes": ["shared", "isolated"]
  },
  "evaluation": {
    "criteria": ["delivery", "integrity", "efficiency", "collaboration", "reliability"],
    "scoreSchemaVersion": "v1",
    "logKinds": ["team-log", "runtime-log"]
  },
  "evolution": {
    "enabled": true,
    "mutablePaths": [
      "prompt.suffix",
      "tools.allowed",
      "permissions.maxTurns",
      "routing.models.default",
      "routing.models.reasoning"
    ],
    "scoreTargets": ["delivery", "integrity", "efficiency", "collaboration", "reliability"]
  },
  "hooks": {
    "postToolUse": [
      {
        "matcher": "score_agent",
        "command": "echo \"Score submitted\"",
        "description": "Log when supervisor submits a score"
      }
    ]
  },
  "market": {
    "category": "coordination",
    "tags": ["supervisor", "bypass", "monitoring"],
    "lifecycle": "active"
  },
  "package": {
    "ref": "@official/supervisor:1",
    "digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  }
}
```

## 3. Required fields

- `kind`
  - Must be `aha.agent.v1`
- `name`
  - Human-readable local name
- `runtime`
  - Which runtime adapter should launch it
- one of:
  - `baseRoleId`
  - `prompt.system`

This last rule means:

- either extend a built-in role
- or provide a full standalone prompt

## 4. Field groups

### 4.1 Core identity

- `kind`
- `name`
- `description`
- `baseRoleId`
- `runtime`

This is the minimum needed to know what the agent is and how it should start.

### 4.2 Prompt

- `prompt.system`
- `prompt.suffix`

Use this when the agent needs custom instructions.

### 4.3 Tools

- `tools.allowed`
- `tools.disallowed`
- `tools.mcpServers`
- `tools.skills`

This controls what the agent may use.

### 4.4 Permissions

- `permissions.permissionMode`
- `permissions.accessLevel`
- `permissions.executionPlane`
- `permissions.maxTurns`

This controls runtime safety and execution shape.

### 4.5 Context

- `context.teamRole`
- `context.capabilities`
- `context.messaging`
- `context.behavior`

This controls how the agent behaves inside the Aha-native team protocol.

### 4.6 Environment

- `env.required`
- `env.optional`

This tells the engine what environment variables are needed before launch.

### 4.7 Evaluation

- `evaluation.criteria`
- `evaluation.scoreSchemaVersion`
- `evaluation.logKinds`

Important:

- this section defines **how the agent should be evaluated**
- it does **not** store actual score results

Actual evaluation records and aggregated scores belong in `genome-hub`.

### 4.8 Routing

- `routing.strategy`
- `routing.providerOrder`
- `routing.models`

This is the smallest place to put runtime model-routing hints.

This is where `cc-switch` was useful as a reference:

- it keeps one internal provider object
- then maps that object into Claude/Codex/Gemini-specific live config
- and it keeps model routing separate from the higher-level app object

For us, that means:

- card stays stable
- engine adapter reads routing hints
- runtime-specific model selection stays configurable without rewriting the whole card

### 4.9 Workspace

- `workspace.defaultMode`
- `workspace.allowedModes`

These fields declare how the package may be materialized into a runtime workspace.

Supported modes:

- `shared`
  - multiple agents share the same project code workspace
  - runtime-specific state still needs isolation
- `isolated`
  - agent gets its own isolated working view
  - better fit for mutation experiments, rollback comparisons, or agent-specific hooks

Key point:

- workspace isolation is **not** implemented by patching Claude/Codex SDK internals
- it is implemented by a materializer that creates an agent-specific runtime workspace

Typical materialization result:

```text
.aha/runtime/<agent-id>/
  workspace/
    .claude/
      settings.json
      commands/
  logs/
  cache/
  tmp/
```

Only the workspace view is isolated; shared public resources may still be linked in.

### 4.10 Evolution

- `evolution.enabled`
- `evolution.parentRef`
- `evolution.parentDigest`
- `evolution.mutationNote`
- `evolution.mutablePaths`
- `evolution.scoreTargets`

This section does **not** store scores.

Instead, it tells the system:

- whether this card participates in evolution
- what it came from
- which parts are allowed to change
- which score dimensions matter when deciding mutation/promote/discard

This is the minimum needed for evolution support.

Without this section, the config can run, but evolution has no clear mutation surface.

### 4.11 Hooks

- `hooks.preToolUse`
- `hooks.postToolUse`
- `hooks.stop`

Claude Code lifecycle hooks bound to this agent.

Each hook entry specifies a `matcher` (tool name glob) and a `command` (shell command to execute).
These are materialized into the agent's runtime workspace settings before launch.

Without hooks, the agent runs with whatever hooks are configured globally or per-project.

Hooks are the clearest reason shared mode has limits:

- if hook differences can be expressed via per-process settings injection, shared mode may remain safe
- only when the required hook behavior would mutate the shared workspace-visible settings should the runtime auto-upgrade to isolated mode or reject the launch

### 4.12 Market

- `market.namespace`
- `market.category`
- `market.tags`
- `market.lifecycle`

This is lightweight publishing metadata.

### 4.13 Package

- `package.ref`
- `package.digest`

These are optional in v1 local files.

Use them when the config has been published or installed through a registry flow.

Important boundary:

- `package.*` is **package identity**, not runtime build output
- there is deliberately **no** `package.build` section in v1
- generated runtime artifacts such as:
  - materialized `settings.json`
  - materialized `env.json`
  - per-agent command visibility view
  belong to the workspace materializer, not to checked-in package identity

Plainly:

- `package.ref` = package name/version identity
- `package.digest` = exact file fingerprint
- runtime build/materialization = launch-time output, not stored in `agent.json`

## 5. What `digest` means

`digest` is just the file's fingerprint.

Example:

- same file -> same digest
- change one line -> different digest

Why we need it later:

- supervisor score must bind to one exact config version
- market display must know which package was actually evaluated
- org-manager reuse must point to the same exact package

Plainly:

- `package.ref` = package name
- `package.digest` = package fingerprint

## 6. Agent Docker runtime composition

An Agent Docker package is not just prompt + model.

For runtime completeness it must be able to express:

- MCP
- skills
- hooks
- env
- routing

In the current flat schema those map to:

| Runtime component | JSON location |
|---|---|
| MCP | `tools.mcpServers` |
| Skills | `tools.skills` |
| Hooks | `hooks.*` |
| Env | `env.*` |
| Routing | `routing.*` |

This is enough for a real package without forcing a six-section JSON redesign.

## 7. Workspace materialization rules

Use these rules when building runtime environments:

- public, read-only skills/MCP templates may come from shared libraries
- per-agent hooks must be materialized into that agent's own workspace
- secrets never belong in shared libraries
- the runtime should prefer:
  - shared mode for ordinary team execution
  - isolated mode for agent-specific hooks, mutation experiments, rollback comparisons

Shared resources may be linked in.
Mutable agent-specific runtime state must remain isolated.

## 8. Can this schema support evolution?

Yes, but only if we separate three things clearly:

1. card config
2. evaluation records
3. aggregated score

`agent.json` should contain:

- what may change
- how it should be evaluated
- what lineage it belongs to

`genome-hub` should contain:

- actual evaluation records
- aggregated scorecard
- public quality projection

So:

- `agent.json` defines the mutation surface
- `genome-hub` stores the results of evolution

This is the key reason we added:

- `routing`
- `workspace`
- `evaluation`
- `evolution`

Together they make the file not just runnable, but evolvable.

## 9. What does NOT belong in `agent.json`

Do not store these here:

- current runtime PID
- current session ID
- current team membership state
- actual score result
- aggregated market score
- recent run logs

Those belong to:

- engine runtime state
- team/session state
- `genome-hub` evaluation and aggregation records

## 10. SDK boundary rule

Do not solve Agent Docker by patching SDK internals or session base classes.

In particular, keep Agent Docker logic out of:

- `src/claude/sdk/*`
- `src/claude/session.ts`

Preferred integration point:

- package parser
- runtime materializer
- `runClaude.ts` / `runCodex.ts` adapter layer

That keeps the SDK wrapper generic and the Agent Docker behavior at the correct architectural layer.

## 11. Why this schema is small

This file is deliberately smaller than the long-term package model.

v1 exists to unlock:

1. `aha run ./agent.json`
2. one internal canonical object for runtime
3. one evaluation anchor for supervisor

Once that works, we can extend toward:

- published package refs
- digests
- richer install/build metadata
- adapter-specific packaging
- richer market projections
