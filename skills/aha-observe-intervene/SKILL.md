# aha-observe-intervene

Observe and intervene in running teams and agents via the `aha` CLI (v13+).
Use this skill when you need to monitor team state, read messages, or send interventions without leaving the terminal.

---

## Prerequisites

```bash
# All commands use these env vars (set once per shell session)
export AHA_HOME_DIR=/Users/copizza/.aha-v13
export AHA_SERVER_URL=http://localhost:3505
export GENOME_HUB_URL=http://localhost:3506

# Alias for convenience
alias aha13="node /opt/homebrew/bin/aha-v13"
```

---

## 1. Observe: Teams

```bash
# List all teams
aha13 teams list
aha13 teams list --verbose --json

# Full team status (tasks + members + progress)
aha13 teams status <teamId>

# Show team roster
aha13 teams show <teamId>

# List team members with roles
aha13 teams members <teamId>

# Read team chat messages (last 20)
aha13 teams messages <teamId>
aha13 teams messages <teamId> --limit 50
aha13 teams messages <teamId> --limit 50 --json   # raw JSON

# Token usage and cost
aha13 usage team <teamId>
```

## 2. Observe: Tasks

```bash
# List tasks for a team
aha13 tasks list --team <teamId>

# Show task detail + comments
aha13 tasks show <taskId> --team <teamId>
aha13 tasks show <taskId> --team <teamId> --json  # includes comments array
```

## 3. Observe: Agents

```bash
# List all agent sessions
aha13 agents list
aha13 agents list --active --team <teamId>

# Show agent detail (role, host, summary)
aha13 agents show <sessionId>

# Read agent CC log (tool calls + assistant turns, last 50)
aha13 agents logs <sessionId>
aha13 agents logs <sessionId> --lines 100

# Read decrypted agent conversation messages
aha13 agents messages <sessionId>
aha13 agents messages <sessionId> --limit 50
aha13 agents messages <sessionId> --json
```

---

## 4. Intervene: Teams

```bash
# Send a message to the team chat (all agents receive it)
aha13 teams send <teamId> "Please pause and report current status"
aha13 teams send <teamId> "@master escalate the blocker on task X" --type chat
aha13 teams send <teamId> "🚨 Deployment paused — wait for approval" --type notification

# Create a task
aha13 tasks create --team <teamId> --title "Urgent: fix X" --priority urgent

# Update task status
aha13 tasks start <taskId> --team <teamId>
aha13 tasks done <taskId> --team <teamId>

# Add a member
aha13 teams add-member <teamId> --session <sessionId> --role builder
```

## 5. Intervene: Agents

```bash
# Send a message directly to an agent's stdin (injected as user input)
aha13 agents send <sessionId> "Stop current task and report blockers"
aha13 agents send <sessionId> "Your priority has changed: focus on X"

# Kill (archive) an agent
aha13 agents kill <sessionId>

# Spawn a new agent
aha13 agents spawn ./path/to/agent.json --team <teamId>
```

---

## 6. Common Workflows

### Observe a sprint in real time
```bash
# 1. Check team health
aha13 teams status 4a01b87f-2d75-4cdb-aab1-405c7ed9a1a0

# 2. Read recent team chat
aha13 teams messages 4a01b87f-2d75-4cdb-aab1-405c7ed9a1a0 --limit 10

# 3. Check which agent is in-progress
aha13 tasks list --team 4a01b87f-2d75-4cdb-aab1-405c7ed9a1a0 | grep in-progress

# 4. Read that agent's recent log
aha13 agents logs <assigneeSessionId> --lines 20
```

### Intervene in a blocked team
```bash
# 1. Broadcast to all agents
aha13 teams send <teamId> "🔴 All agents: stand down. Await reassignment."

# 2. Direct-message the supervisor
aha13 agents send <supervisorSessionId> "Re-prioritize: task X is now P0"

# 3. Create a new task for the fix
aha13 tasks create --team <teamId> --title "P0: unblock X" --priority urgent \
  --assignee <supervisorSessionId>
```

### Monitor token cost
```bash
aha13 usage team <teamId>
# Shows per-agent token counts + total cost
```

---

## 7. Output formats

| Flag | Effect |
|------|--------|
| `--json` | Machine-readable JSON (pipe to jq) |
| `--verbose` | Extra metadata fields |
| `--limit N` | Cap number of results |
| `--before <cursor>` | Pagination for messages |

### Pipe to jq example
```bash
aha13 teams status <teamId> --json | jq '.tasks | group_by(.status) | map({status: .[0].status, count: length})'
aha13 agents messages <sessionId> --json | jq '.messages[] | select(.role=="assistant") | .content[:200]'
```

---

## 8. What agents hear

- `teams send` → stored in team chat, picked up by agents via `read_team_log` MCP tool
- `agents send` → injected directly into agent stdin as a user turn (immediate, synchronous)

Use `teams send` for broadcast / async coordination.
Use `agents send` for direct, synchronous intervention on a specific agent.
