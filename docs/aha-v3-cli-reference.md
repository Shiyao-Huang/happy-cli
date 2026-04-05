# Aha CLI v3 Reference

> **For CLI users, CI systems, and external integrators.**
> Complete command syntax, workflows, and configuration reference.

> See also: [`aha-v3-team-deliveries.md`](./aha-v3-team-deliveries.md) — isolated note for the cross-cutting features delivered through the team this sprint.

---

## Installation

```bash
npm install -g cc-aha-cli-v3
# or
yarn global add cc-aha-cli-v3
```

Use the versioned `aha-v3` command after install. `kanban-v3` is provided as an alias to the same CLI binary.

---

## Global Options

```
aha-v3 [command] [options]

Options:
  -h, --help        Show help
  -v, --version     Show version
  --debug           Enable debug logging
```

---

## Commands

### `aha-v3 auth`

Authentication management.

```bash
aha-v3 auth login                       # Default auth flow
aha-v3 auth reconnect                   # Reconnect using current local credential material
aha-v3 auth login --code <backup-key>   # Restore a known account from a one-time ticket
aha-v3 auth join --ticket <ticket>      # Join an existing account from a join link
aha-v3 auth login --force              # Create or switch to a fresh account
aha-v3 auth status                     # Show current auth + machine + daemon state
aha-v3 auth logout                     # Clear stored credentials
```

See also: [`auth-recovery-account-consistency.md`](./auth-recovery-account-consistency.md)

### `aha-v3 connect`

AI vendor API key management.

```bash
aha-v3 connect list            # List configured vendors
aha-v3 connect claude          # Configure Anthropic API key
aha-v3 connect codex           # Configure OpenAI Codex key
aha-v3 connect gemini          # Configure Gemini key
aha-v3 connect remove <vendor> # Remove a vendor configuration
```

### `aha-v3 doctor`

Diagnostics and cleanup.

```bash
aha-v3 doctor                  # Run full diagnostics
aha-v3 doctor clean            # Kill runaway aha processes
```

### `aha-v3 teams` (alias: `aha-v3 team`)

Team CRUD and member management.

```bash
# Listing
aha-v3 teams list                          # List all teams
aha-v3 teams list --json                   # JSON output
aha-v3 teams show <teamId>                 # Show team details
aha-v3 teams show <teamId> --json          # JSON output

# Create / Modify
aha-v3 teams create --name "Sprint 42"     # Create team (auto-generates ID)
aha-v3 teams create --name "MyTeam" --id "my-team-id"
aha-v3 teams rename <teamId> <new-name>

# Archive / Delete
aha-v3 teams archive <teamId>             # Soft-delete
aha-v3 teams archive <teamId> --force     # Skip confirmation
aha-v3 teams delete <teamId>              # Hard delete
aha-v3 teams delete <teamId> --force

# Batch operations
aha-v3 teams batch-archive <id1> <id2>
aha-v3 teams batch-archive --ids "id1,id2,id3"
aha-v3 teams batch-delete <id1> <id2>

# Member management
aha-v3 teams members <teamId>                               # List members
aha-v3 teams add-member <teamId> --session <sessionId> \
  --role builder --spec-id "@official/builder:1"
aha-v3 teams remove-member <teamId> --session <sessionId>
```

### `aha-v3 tasks`

Kanban task management.

```bash
# Listing
aha-v3 tasks list --team <teamId>                    # List all tasks
aha-v3 tasks list --team <teamId> --status in-progress
aha-v3 tasks list --team <teamId> --json
aha-v3 tasks show <taskId> --team <teamId>

# Create
aha-v3 tasks create --team <teamId> \
  --title "Implement auth" \
  --description "..." \
  --priority high \
  --assignee <sessionId>

# Update
aha-v3 tasks update <taskId> --team <teamId> --status done
aha-v3 tasks update <taskId> --team <teamId> --priority urgent
aha-v3 tasks update <taskId> --team <teamId> --assignee <sessionId>

# Lifecycle
aha-v3 tasks start <taskId> --team <teamId>
aha-v3 tasks complete <taskId> --team <teamId>
aha-v3 tasks delete <taskId> --team <teamId> [--force]

# Options
  --status todo|in-progress|review|blocked|done
  --priority low|medium|high|urgent
  --labels "label1,label2"
  --assignee <sessionId>
  --approval-status pending|approved|rejected
```

### `aha-v3 agents` (alias: `aha-v3 agent`)

Agent session management.

```bash
aha-v3 agents list                     # List all agent sessions
aha-v3 agents list --active            # Active sessions only
aha-v3 agents list --team <teamId>     # Filter by team
aha-v3 agents list --role builder      # Filter by role
aha-v3 agents list --json

aha-v3 agents show <sessionId>
aha-v3 agents show <sessionId> --json

aha-v3 agents update <sessionId> \
  --name "My Builder" \
  --role builder \
  --team <teamId> \
  --summary "Implementing auth module"

aha-v3 agents archive <sessionId> [--force]
aha-v3 agents delete <sessionId> [--force]

# Spawn agent from local agent JSON (Docker format → running team agent)
aha-v3 agents spawn <path/to/agent.json> \
  [--team <teamId>] \
  [--role <roleId>] \
  [--path <cwd>]
```

**`spawn` materializes workspace locally, then spawns via daemon:**
1. Reads + validates `agent.json` (`kind: aha.agent.v1`)
2. Runs `materializeAgentWorkspace()` → hooks, skills, env contract written to `~/.aha-v3/runtime/<agentId>/`
3. Daemon spawns session with `AHA_SETTINGS_PATH` pointing to materialized `settings.json`
4. If `--team` provided, registers agent in team roster

### `aha-v3 roles`

Role pool and review management.

```bash
aha-v3 roles pool                      # List role pool
aha-v3 roles review <sessionId>        # Review agent session
aha-v3 roles team-score <teamId>       # View team performance scores
```

### `aha-v3 ralph`

Ralph autonomous loop — drives PRD tasks to completion.

```bash
aha-v3 ralph start --team <teamId> --prd prd.json
aha-v3 ralph status --team <teamId>
aha-v3 ralph stop --team <teamId>
```

### `aha-v3 codex`

Start Codex (OpenAI) runtime team collaboration mode.

```bash
aha-v3 codex
```

### `aha-v3 notify`

Send push notifications.

```bash
aha-v3 notify -p "Build complete!"
aha-v3 notify -p "Deployment failed" -t "alert"
```

### `aha-v3 daemon`

Background service management.

```bash
aha-v3 daemon list                    # List active daemon sessions
aha-v3 daemon stop <sessionId>        # Stop a daemon session
```

---

## Key Workflows

### 1. Create a Team and Launch Agents

```bash
# 1. Create team
TEAM_ID=$(aha-v3 teams create --name "sprint-42" --json | jq -r '.team.id')

# 2. Start agent (aha-v3 CLI spawns and auto-registers)
AHA_ROOM_ID=$TEAM_ID aha-v3

# 3. Verify agent is in team
aha-v3 teams members $TEAM_ID

# 4. Create initial tasks
aha-v3 tasks create --team $TEAM_ID \
  --title "Implement feature X" \
  --priority high
```

### 2. CI Team Management (GitHub Actions)

```yaml
# .github/workflows/aha-team.yml
env:
  ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  AHA_SERVER_URL: ${{ secrets.AHA_SERVER_URL }}

jobs:
  run-team:
    steps:
      - name: Create team
        run: |
          TEAM_ID=$(aha-v3 teams create --name "ci-${{ github.run_id }}" --json | jq -r '.team.id')
          echo "TEAM_ID=$TEAM_ID" >> $GITHUB_ENV

      - name: Materializer smoke test
        run: yarn vitest run src/agentDocker/

      - name: Launch Ralph loop
        run: |
          AHA_ROOM_ID=$TEAM_ID aha-v3 ralph start \
            --team $TEAM_ID --prd prd.json

      - name: Cleanup
        if: always()
        run: aha-v3 teams archive $TEAM_ID --force
```

### 3. Docker Agent Bootstrap (with workspace materializer)

```bash
# Workspace is materialized from genome spec
# Settings, hooks, MCP config auto-generated at:
#   ~/.aha-v3/runtime/<agentId>/workspace/.claude/settings.json

docker run -d \
  --name "aha-builder" \
  --env AHA_ROOM_ID=$TEAM_ID \
  --env ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  --env AHA_TEAM_MEMBER_ID=$(uuidgen) \
  aha-runtime-claude:latest
```

### 4. Task Assignment Workflow

```bash
# List available tasks
aha-v3 tasks list --team $TEAM_ID --status todo

# Assign to agent
aha-v3 tasks update $TASK_ID --team $TEAM_ID \
  --assignee $SESSION_ID \
  --status in-progress

# Mark complete
aha-v3 tasks complete $TASK_ID --team $TEAM_ID
```

---

## Docker Agent JSON Format

Docker agents are defined in `*.agent.json` files validated against `schemas/agent-json-v1.schema.json`.

```json
{
  "$schema": "../../schemas/agent-json-v1.schema.json",
  "kind": "aha.agent.v1",
  "name": "builder",
  "runtime": "claude",
  "tools": {
    "mcpServers": ["aha"],
    "skills": ["review", "ship"]
  },
  "env": {
    "required": ["ANTHROPIC_API_KEY"],
    "optional": ["AHA_ROOM_ID"]
  },
  "workspace": {
    "defaultMode": "shared",
    "allowedModes": ["shared", "isolated"]
  },
  "hooks": {
    "postToolUse": [
      {
        "matcher": "Edit",
        "command": "prettier --write \"$CLAUDE_TOOL_INPUT_FILE_PATH\" 2>/dev/null || true"
      }
    ]
  }
}
```

**Runtime values:** `claude` | `codex` | `open-code`

**Workspace modes:**
- `shared` — agent CWD = `repoRoot` (direct repo access)
- `isolated` — agent CWD = materialized project view (P2: git worktree)

**Hook matchers:** Tool name (e.g. `"Edit"`, `"Bash"`, `"Read"`) or `"*"` for all tools.

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `AHA_SERVER_URL` | `https://top1vibe.com/api/v2` | API server endpoint |
| `AHA_WEBAPP_URL` | `https://top1vibe.com/webappv2` | Web app URL |
| `AHA_HOME_DIR` | `~/.aha-v3` | Aha home directory |
| `AHA_ROOM_ID` | — | Team room ID (required for team features) |
| `AHA_AGENT_ROLE` | — | Declare agent role |
| `AHA_TEAM_MEMBER_ID` | — | Override agent session ID (workspace materialization) |
| `AHA_PERMISSION_MODE` | `default` | `default\|acceptEdits\|bypassPermissions` |
| `ANTHROPIC_API_KEY` | — | Claude API key |
| `AHA_ALLOW_SOURCE_FALLBACK` | `0` | Set `1` to run from source (dev only) |
| `DEBUG` | — | Set `1` to enable debug logging |

---

## File Paths

| Path | Purpose |
|------|---------|
| `~/.aha-v3/` | Aha home directory |
| `~/.aha-v3/runtime/<agentId>/` | Per-agent runtime root |
| `~/.aha-v3/runtime/<agentId>/workspace/.claude/settings.json` | Per-agent hooks settings |
| `~/.aha-v3/runtime/<agentId>/workspace/.claude/commands/` | Skill symlinks |
| `~/.aha-v3/runtime/<agentId>/workspace/.aha-agent/env.json` | Env contract |
| `~/.aha-v3/runtime/<agentId>/workspace/.aha-agent/mcp.json` | MCP server list |
| `~/.aha-v3/runtime/<agentId>/logs/` | Agent logs |
| `~/.aha-v3/runtime-lib/skills/` | Global skill library |
| `~/.aha-v3/worktrees/<agentId>/` | Isolated git worktrees (P2) |

---

## Schemas

| Schema | Path | Purpose |
|--------|------|---------|
| Agent JSON v1 | `schemas/agent-json-v1.schema.json` | Validate `*.agent.json` files |

---

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error (message printed to stderr) |

---

<!--────────────────────────────────────────────────────────────────────────
  SPRINT ADDITIONS — 2026-03-18
  Status: experimental / pending integration review
  These features are isolated here so they can be evaluated independently.
  Stable items will be merged into the main sections above.
────────────────────────────────────────────────────────────────────────-->

## Sprint Additions (2026-03-18)

> **Scope note:** The features below were delivered in the 2026-03-18 sprint.
> They are documented separately because their production impact is still being evaluated.
> Nothing here changes previously documented behavior; all additions are additive.

---

### New: `aha-v3 sessions` command

Direct session management (independent of agent metadata).

```bash
aha-v3 sessions list                     # List all sessions
aha-v3 sessions list --active            # Active sessions only
aha-v3 sessions list --json

aha-v3 sessions show <sessionId>         # Show session + model info
aha-v3 sessions show <sessionId> --json

aha-v3 sessions archive <sessionId> [--force]
aha-v3 sessions delete <sessionId> [--force]
```

**`sessions show` output includes** (when available in metadata):
```
<sessionId>  active  [builder]  My Builder
  team=team_123  messages=42  path=/repo
  resolvedModel=claude-sonnet-4-6
  contextWindowTokens=200000
```

`resolvedModel` and `contextWindowTokens` are written to session metadata by the runtime on each user message (see Agent Model Self-Awareness in `aha-v3-agent-guide.md`).

---

### New: `aha-v3 agents update --model` / `--fallback-model`

Override the model for an existing agent session (takes effect on next restart).

```bash
aha-v3 agents update <sessionId> --model claude-opus-4-5
aha-v3 agents update <sessionId> --model claude-haiku-4-5 --fallback-model claude-sonnet-4-5
```

**Stored as:** `metadata.modelOverride` / `metadata.fallbackModelOverride`

**Priority chain:** CLI `--model` flag > `modelOverride` in session metadata > genome `modelId` > system default

**Note:** `metadata.modelOverride` is read once at session startup. Changing it takes effect the next time the agent session is started/restarted, not immediately.

---

### New: `update_agent_model` MCP tool

Supervisor/master can switch an agent's model without CLI access.

```
update_agent_model({
  sessionId: "cmmvx...",
  modelId: "claude-opus-4-5",
  fallbackModelId: "claude-sonnet-4-5"   // optional
})
```

**Access:** `supervisor` and `master` only.

**Effect:** Writes `modelOverride` to session metadata. Takes effect the next time the target agent session is restarted.

---

### New: `runtime-lib` materialization policies

When `materializeAgentWorkspace()` builds a workspace, resources are placed using one of two policies:

| Policy | Mechanism | When used |
|--------|-----------|-----------|
| `link` | Symlink to `~/.aha-v3/runtime-lib/` | Default — shared read-only resources (skills, MCP configs) |
| `copy` | Full copy into workspace | When `build.materializationPolicy: "copy"` set in `agent.json` |

**`agent.json` opt-in:**
```json
{
  "build": {
    "materializationPolicy": "copy"
  }
}
```

**Shared library layout** under `~/.aha-v3/runtime-lib/`:
```
~/.aha-v3/runtime-lib/
├── skills/
├── mcp/
├── prompts/
├── hooks/
└── tools/
```

---

### New: `.genome/` workspace overlay

When an agent is started from a genome spec, the materializer writes self-awareness files into the workspace:

```
~/.aha-v3/runtime/<agentId>/workspace/.genome/
├── spec.json          ← full genome spec snapshot
├── lineage.json       ← provenance: parentId, mutationNote, origin
└── eval-criteria.md   ← evaluation criteria (when defined in genome)
```

A `__genome_ref__` entry is also injected into `contextInjections` so the agent knows its own `specId` and genome version from the system prompt.

**These files are read-only reference.** Do not modify them.

---

### New env var: `AHA_SETTINGS_PATH`

Used by `aha-v3 agents spawn` to pass a pre-materialized `settings.json` path to the daemon.

| Variable | Purpose |
|----------|---------|
| `AHA_SETTINGS_PATH` | Path to a pre-materialized `settings.json`; bypasses genome fetch when set (genome takes precedence if `AHA_SPEC_ID` is also set) |

Set automatically by `aha-v3 agents spawn`. Does not need to be set manually in normal operation.

<!--────────────────────────────────────────────────────────────────────────
  END: SPRINT ADDITIONS — 2026-03-18
────────────────────────────────────────────────────────────────────────-->
