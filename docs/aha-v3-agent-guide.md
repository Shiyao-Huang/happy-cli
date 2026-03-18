# Aha v3 Agent Guide

> **Internal reference for agents running inside the Aha team system.**
> Read this first when you join a team session.

> See also: [`aha-v3-team-deliveries.md`](./aha-v3-team-deliveries.md) — isolated internal note for the sprint deliverables shipped through team collaboration.

---

## 1. Who Am I?

When you start, you receive an injected system prompt that tells you:

| Field | What it means |
|-------|---------------|
| **Role** | Your function in the team (`master`, `builder`, `qa`, `supervisor`, etc.) |
| **Session ID** | Your unique identifier (`cmmvx...`) |
| **Team ID** (`AHA_ROOM_ID`) | The room you are operating in |
| **Execution plane** | `mainline` (normal) or `bypass` (can skip user approval) |
| **Access level** | `full-access` (all tools) or `read-only` |

### Role Hierarchy

```
user
 └─ master (entry point for user messages)
     ├─ supervisor  (monitors, scores, re-assigns)
     ├─ orchestrator / org-manager  (spawns sub-teams)
     ├─ builder  (implements tasks)
     ├─ qa  (validates work)
     └─ help-agent  (resolves blockers)
```

**Bypass roles** (`help-agent`, `supervisor`): run on `executionPlane: bypass`, can act without user confirmation.

**Mainline coordination roles** (`org-manager`, `master`, `orchestrator`): run on `executionPlane: mainline`.

**Mainline worker roles** (`builder`, `qa`): run on `executionPlane: mainline`, require normal permission flow.

---

## 2. My Tools

### MCP Tools (33 tools across 6 categories)

#### 2.1 Memory & Context

| Tool | Purpose |
|------|---------|
| `remember` | Save a fact to persistent memory |
| `recall` | Retrieve saved facts |
| `update_context` | Update your own context/working notes |
| `get_context_status` | Check context window usage and compression status |
| `change_title` | Update the current session title |

#### 2.2 Team Communication

| Tool | Purpose |
|------|---------|
| `send_team_message` | Broadcast a message to the team (`type: chat\|task-update\|notification`) |
| `read_team_log` | Read recent team messages |
| `get_team_info` | Get current team metadata and member list |

#### 2.3 Task / Kanban

| Tool | Purpose |
|------|---------|
| `list_tasks` | List tasks (your assigned tasks, available tasks, team stats) |
| `create_task` | Create a new task on the board |
| `update_task` | Update task fields (status, priority, assignee, description) |
| `delete_task` | Delete a task |
| `start_task` | Mark a task as in-progress (creates execution link to your session) |
| `complete_task` | Mark a task as done |
| `create_subtask` | Create a subtask under a parent |
| `list_subtasks` | List subtasks of a parent |
| `report_blocker` | Report a blocker on a task |
| `resolve_blocker` | Resolve a previously reported blocker |

#### 2.4 Agent Management

| Tool | Purpose |
|------|---------|
| `list_available_agents` | List all available agent roles/genomes |
| `list_team_agents` | List agents currently in the team |
| `create_agent` | Spawn a new agent with a genome spec |
| `kill_agent` | Terminate a running agent session |
| `compact_agent` | Trigger context compaction for an agent |
| `score_agent` | Score an agent's performance (0-10 with rationale) |
| `score_supervisor_self` | Self-score as supervisor |
| `update_genome_feedback` | Submit feedback to improve a genome |
| `create_genome` | Create a new genome definition |

#### 2.5 Logs & Diagnostics

| Tool | Purpose |
|------|---------|
| `read_cc_log` | Read Claude Code log for a session |
| `list_team_cc_logs` | List all CC logs for the team |
| `list_team_runtime_logs` | List all runtime logs |
| `read_runtime_log` | Read a specific runtime log |

#### 2.6 Coordination

| Tool | Purpose |
|------|---------|
| `request_help` | Escalate a blocker to the help-agent |
| `save_supervisor_state` | Save supervisor state snapshot |

---

## 3. Team Collaboration Protocol

### How to Read Your Tasks

```
list_tasks()   →  returns myTasks + availableTasks + teamStats
```

**Always check `myTasks` first.** If empty, announce yourself and wait for assignment.

### How to Start a Task

```
1. start_task(taskId)          ← creates execution link
2. [do the work]
3. complete_task(taskId)       ← closes the card
4. send_team_message(...)      ← report completion
```

### How to Report Progress

Use `send_team_message` with `type: "task-update"` for status changes:
```
send_team_message({
  content: "Task X: in-progress. Starting implementation of Y.",
  type: "task-update",
  shortContent: "Starting implementation of Y"
})
```

### How to Report Blockers

```
report_blocker(taskId, description)   ← records the blocker
request_help({ ... })                 ← escalates to help-agent
```

### Messaging Routing

| You are | Your messages go to |
|---------|-------------------|
| `master` | User (entry point) |
| `builder` / `qa` | Respond to `master`, `orchestrator`, `architect` |
| `supervisor` | All agents |
| `help-agent` | Whoever called `request_help` |

Use `@sessionId` or `@roleName` in `send_team_message` `mentions` to notify specific agents.

---

## 4. Workspace & Settings

### Per-Agent Workspace Layout

```
~/.aha/runtime/<agentId>/
├── workspace/
│   ├── .claude/
│   │   ├── settings.json    ← hooks (auto-generated from genome)
│   │   └── commands/        ← skill symlinks
│   └── .aha-agent/
│       ├── env.json         ← required/optional env vars + overrides
│       └── mcp.json         ← MCP server list
├── logs/
├── cache/
└── tmp/
```

### Workspace Modes

| Mode | `effectiveCwd` | Use case |
|------|---------------|---------|
| `shared` | `repoRoot` | Direct access to repo (default) |
| `isolated` | `projectViewPath` symlink | Sandboxed view (P2: git worktree) |

### Skills

Skills are slash-commands available in `commands/` directory. The agent's system prompt lists available skills. Invoke with `/skill-name`.

### Hooks

Hooks in `settings.json` auto-execute around tool calls:
- `PreToolUse`: before tool execution (validation, logging)
- `PostToolUse`: after tool execution (formatting, auditing)
- `Stop`: at session end (cleanup, final verification)

---

## 5. Common Anti-Patterns

| Anti-Pattern | Why Bad | Correct Behavior |
|--------------|---------|-----------------|
| Starting work without `start_task` | No visibility, orphaned execution | Always call `start_task` first |
| Reading files to "discover" tasks | Invents work not requested | Tasks come from Kanban only |
| Silent errors | Team can't see blockers | Use `report_blocker` / `request_help` |
| Working on unassigned tasks | Duplicates effort | Wait for `myTasks` assignment |
| Committing without running tests | Broken builds | Run build/test before `complete_task` |
| Never sending `send_team_message` | Team is blind | Report start, progress, and completion |

---

## 6. Agent Lifecycle

```
join team
  ↓
announce: send_team_message("🟢 [ROLE] Online and ready")
  ↓
list_tasks() → check myTasks
  ↓
[empty]              [has tasks]
  ↓                      ↓
wait for            start_task()
assignment              ↓
                    implement
                        ↓
                    complete_task()
                        ↓
                    send_team_message(completion)
                        ↓
                    back to list_tasks()
```

---

## 7. Key Environment Variables

| Variable | Purpose |
|----------|---------|
| `AHA_ROOM_ID` | Team room ID (required for team tools) |
| `ANTHROPIC_API_KEY` | Claude API key |
| `AHA_HOME_DIR` | Override `~/.aha` home directory |
| `AHA_SERVER_URL` | Override API server URL |
| `AHA_AGENT_ROLE` | Declare agent role |
| `AHA_TEAM_MEMBER_ID` | Session ID for workspace materialization |
| `DEBUG` | Enable verbose debug logging |

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

### New: Agent Model Self-Awareness

Every agent now receives a **Runtime Model Identity** block injected into its append system prompt at startup and refreshed on each user message:

```
## Runtime Model Identity
- Current model: claude-sonnet-4-6
- Fallback model: claude-haiku-4-5
- Context window: 200000 tokens
```

This block is generated from:
- `currentModel` — the active model (CLI flag > `modelOverride` metadata > genome default)
- `currentFallbackModel` — fallback if primary is unavailable
- `contextWindowTokens` — resolved from the model context window map

**Key behavior:** The block is refreshed on every user message, so if the model changes mid-session the agent's self-awareness stays current.

**Metadata side-effects:** After each refresh, two fields are written to session metadata:
- `metadata.resolvedModel` — the current active model ID
- `metadata.contextWindowTokens` — the resolved token count

These are visible in `aha sessions show <sessionId>`.

---

### New: `update_agent_model` MCP tool (supervisor/master only)

Master or supervisor can change an agent's model without CLI access.

```
update_agent_model({
  sessionId: "cmmvx...",
  modelId: "claude-opus-4-5",
  fallbackModelId: "claude-sonnet-4-5"   // optional
})
```

**Access restriction:** `supervisor` and `master` roles only.

**Effect timing:** Writes `metadata.modelOverride`. The change takes effect the next time the target agent's session is **restarted** — not immediately on the next tool call.

---

### New: `.genome/` self-knowledge files

When you are started from a genome spec, your workspace contains:

```
.genome/
├── spec.json          ← your full genome definition
├── lineage.json       ← { parentId, mutationNote, origin }
└── eval-criteria.md   ← what you will be scored on (if defined)
```

Your system prompt also includes a `__genome_ref__` context injection with your `specId` and genome version.

**These files are read-only.** They exist so you can understand your own configuration — do not modify them.

---

### New env var: `AHA_SETTINGS_PATH`

When you are spawned via `aha agents spawn` (from a local `agent.json`), the daemon sets this variable pointing to your pre-materialized `settings.json`. You do not need to interact with it directly; it is consumed transparently by the runtime.

<!--────────────────────────────────────────────────────────────────────────
  END: SPRINT ADDITIONS — 2026-03-18
────────────────────────────────────────────────────────────────────────-->
