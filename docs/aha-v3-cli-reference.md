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

---

## Global Options

```
aha [command] [options]

Options:
  -h, --help        Show help
  -v, --version     Show version
  --debug           Enable debug logging
```

---

## Commands

### `aha auth`

Authentication management.

```bash
aha auth login              # Open browser to authenticate
aha auth logout             # Clear stored credentials
```

### `aha connect`

AI vendor API key management.

```bash
aha connect list            # List configured vendors
aha connect claude          # Configure Anthropic API key
aha connect codex           # Configure OpenAI Codex key
aha connect gemini          # Configure Gemini key
aha connect remove <vendor> # Remove a vendor configuration
```

### `aha doctor`

Diagnostics and cleanup.

```bash
aha doctor                  # Run full diagnostics
aha doctor clean            # Kill runaway aha processes
```

### `aha teams` (alias: `aha team`)

Team CRUD and member management.

```bash
# Listing
aha teams list                          # List all teams
aha teams list --json                   # JSON output
aha teams show <teamId>                 # Show team details
aha teams show <teamId> --json          # JSON output

# Create / Modify
aha teams create --name "Sprint 42"     # Create team (auto-generates ID)
aha teams create --name "MyTeam" --id "my-team-id"
aha teams rename <teamId> <new-name>

# Archive / Delete
aha teams archive <teamId>             # Soft-delete
aha teams archive <teamId> --force     # Skip confirmation
aha teams delete <teamId>              # Hard delete
aha teams delete <teamId> --force

# Batch operations
aha teams batch-archive <id1> <id2>
aha teams batch-archive --ids "id1,id2,id3"
aha teams batch-delete <id1> <id2>

# Member management
aha teams members <teamId>                               # List members
aha teams add-member <teamId> --session <sessionId> \
  --role builder --spec-id "@official/builder:1"
aha teams remove-member <teamId> --session <sessionId>
```

### `aha tasks`

Kanban task management.

```bash
# Listing
aha tasks list --team <teamId>                    # List all tasks
aha tasks list --team <teamId> --status in-progress
aha tasks list --team <teamId> --json
aha tasks show <taskId> --team <teamId>

# Create
aha tasks create --team <teamId> \
  --title "Implement auth" \
  --description "..." \
  --priority high \
  --assignee <sessionId>

# Update
aha tasks update <taskId> --team <teamId> --status done
aha tasks update <taskId> --team <teamId> --priority urgent
aha tasks update <taskId> --team <teamId> --assignee <sessionId>

# Lifecycle
aha tasks start <taskId> --team <teamId>
aha tasks complete <taskId> --team <teamId>
aha tasks delete <taskId> --team <teamId> [--force]

# Options
  --status todo|in-progress|review|blocked|done
  --priority low|medium|high|urgent
  --labels "label1,label2"
  --assignee <sessionId>
  --approval-status pending|approved|rejected
```

### `aha agents` (alias: `aha agent`)

Agent session management.

```bash
aha agents list                     # List all agent sessions
aha agents list --active            # Active sessions only
aha agents list --team <teamId>     # Filter by team
aha agents list --role builder      # Filter by role
aha agents list --json

aha agents show <sessionId>
aha agents show <sessionId> --json

aha agents update <sessionId> \
  --name "My Builder" \
  --role builder \
  --team <teamId> \
  --summary "Implementing auth module"

aha agents archive <sessionId> [--force]
aha agents delete <sessionId> [--force]

# Spawn agent from local agent JSON (Docker format → running team agent)
aha agents spawn <path/to/agent.json> \
  [--team <teamId>] \
  [--role <roleId>] \
  [--path <cwd>]
```

**`spawn` materializes workspace locally, then spawns via daemon:**
1. Reads + validates `agent.json` (`kind: aha.agent.v1`)
2. Runs `materializeAgentWorkspace()` → hooks, skills, env contract written to `~/.aha/runtime/<agentId>/`
3. Daemon spawns session with `AHA_SETTINGS_PATH` pointing to materialized `settings.json`
4. If `--team` provided, registers agent in team roster

### `aha roles`

Role pool and review management.

```bash
aha roles pool                      # List role pool
aha roles review <sessionId>        # Review agent session
aha roles team-score <teamId>       # View team performance scores
```

### `aha ralph`

Ralph autonomous loop — drives PRD tasks to completion.

```bash
aha ralph start --team <teamId> --prd prd.json
aha ralph status --team <teamId>
aha ralph stop --team <teamId>
```

### `aha codex`

Start Codex (OpenAI) runtime team collaboration mode.

```bash
aha codex
```

### `aha notify`

Send push notifications.

```bash
aha notify -p "Build complete!"
aha notify -p "Deployment failed" -t "alert"
```

### `aha daemon`

Background service management.

```bash
aha daemon list                    # List active daemon sessions
aha daemon stop <sessionId>        # Stop a daemon session
```

---

## Key Workflows

### 1. Create a Team and Launch Agents

```bash
# 1. Create team
TEAM_ID=$(aha teams create --name "sprint-42" --json | jq -r '.team.id')

# 2. Start agent (aha CLI spawns and auto-registers)
AHA_ROOM_ID=$TEAM_ID aha

# 3. Verify agent is in team
aha teams members $TEAM_ID

# 4. Create initial tasks
aha tasks create --team $TEAM_ID \
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
          TEAM_ID=$(aha teams create --name "ci-${{ github.run_id }}" --json | jq -r '.team.id')
          echo "TEAM_ID=$TEAM_ID" >> $GITHUB_ENV

      - name: Materializer smoke test
        run: yarn vitest run src/agentDocker/

      - name: Launch Ralph loop
        run: |
          AHA_ROOM_ID=$TEAM_ID aha ralph start \
            --team $TEAM_ID --prd prd.json

      - name: Cleanup
        if: always()
        run: aha teams archive $TEAM_ID --force
```

### 3. Docker Agent Bootstrap (with workspace materializer)

```bash
# Workspace is materialized from genome spec
# Settings, hooks, MCP config auto-generated at:
#   ~/.aha/runtime/<agentId>/workspace/.claude/settings.json

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
aha tasks list --team $TEAM_ID --status todo

# Assign to agent
aha tasks update $TASK_ID --team $TEAM_ID \
  --assignee $SESSION_ID \
  --status in-progress

# Mark complete
aha tasks complete $TASK_ID --team $TEAM_ID
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
| `AHA_SERVER_URL` | `https://api.aha.engineering` | API server endpoint |
| `AHA_WEBAPP_URL` | — | Web app URL |
| `AHA_HOME_DIR` | `~/.aha` | Aha home directory |
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
| `~/.aha/` | Aha home directory |
| `~/.aha/runtime/<agentId>/` | Per-agent runtime root |
| `~/.aha/runtime/<agentId>/workspace/.claude/settings.json` | Per-agent hooks settings |
| `~/.aha/runtime/<agentId>/workspace/.claude/commands/` | Skill symlinks |
| `~/.aha/runtime/<agentId>/workspace/.aha-agent/env.json` | Env contract |
| `~/.aha/runtime/<agentId>/workspace/.aha-agent/mcp.json` | MCP server list |
| `~/.aha/runtime/<agentId>/logs/` | Agent logs |
| `~/.aha/runtime-lib/skills/` | Global skill library |
| `~/.aha/worktrees/<agentId>/` | Isolated git worktrees (P2) |

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

### New: `aha sessions` command

Direct session management (independent of agent metadata).

```bash
aha sessions list                     # List all sessions
aha sessions list --active            # Active sessions only
aha sessions list --json

aha sessions show <sessionId>         # Show session + model info
aha sessions show <sessionId> --json

aha sessions archive <sessionId> [--force]
aha sessions delete <sessionId> [--force]
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

### New: `aha agents update --model` / `--fallback-model`

Override the model for an existing agent session (takes effect on next restart).

```bash
aha agents update <sessionId> --model claude-opus-4-5
aha agents update <sessionId> --model claude-haiku-4-5 --fallback-model claude-sonnet-4-5
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
| `link` | Symlink to `~/.aha/runtime-lib/` | Default — shared read-only resources (skills, MCP configs) |
| `copy` | Full copy into workspace | When `build.materializationPolicy: "copy"` set in `agent.json` |

**`agent.json` opt-in:**
```json
{
  "build": {
    "materializationPolicy": "copy"
  }
}
```

**Shared library layout** under `~/.aha/runtime-lib/`:
```
~/.aha/runtime-lib/
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
~/.aha/runtime/<agentId>/workspace/.genome/
├── spec.json          ← full genome spec snapshot
├── lineage.json       ← provenance: parentId, mutationNote, origin
└── eval-criteria.md   ← evaluation criteria (when defined in genome)
```

A `__genome_ref__` entry is also injected into `contextInjections` so the agent knows its own `specId` and genome version from the system prompt.

**These files are read-only reference.** Do not modify them.

---

### New env var: `AHA_SETTINGS_PATH`

Used by `aha agents spawn` to pass a pre-materialized `settings.json` path to the daemon.

| Variable | Purpose |
|----------|---------|
| `AHA_SETTINGS_PATH` | Path to a pre-materialized `settings.json`; bypasses genome fetch when set (genome takes precedence if `AHA_SPEC_ID` is also set) |

Set automatically by `aha agents spawn`. Does not need to be set manually in normal operation.

<!--────────────────────────────────────────────────────────────────────────
  END: SPRINT ADDITIONS — 2026-03-18
────────────────────────────────────────────────────────────────────────-->
