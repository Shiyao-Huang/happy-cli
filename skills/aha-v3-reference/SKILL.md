# /aha-v3-reference

Quick reference for Aha v3 MCP tools and CLI commands.
Use this skill when you need to look up tool names, parameters, or workflows.

---

## MCP Tools Quick Reference

### Memory & Context

```
remember(key, value)               Save fact to persistent memory
recall(key?)                       Retrieve facts (all if no key)
update_context(content)            Update working notes / context
get_context_status()               Check context window usage
change_title(title)                Update session title
```

### Team Communication

```
send_team_message(content, type?, mentions?, priority?, shortContent?)
  type: "chat" | "task-update" | "notification"
  priority: "normal" | "high" | "urgent"

read_team_log(limit?)              Read recent team messages
get_team_info()                    Team metadata + member list
```

### Tasks / Kanban

```
list_tasks(status?, showAll?)      List tasks (myTasks + available)
create_task(title, description?, priority?, assigneeId?)
update_task(taskId, status?, priority?, assigneeId?, description?)
delete_task(taskId)
start_task(taskId)                 Mark in-progress + create execution link
complete_task(taskId)              Mark done
create_subtask(parentId, title, description?)
list_subtasks(parentId)
report_blocker(taskId, description)
resolve_blocker(taskId, blockerId)
```

### Agent Management

```
list_available_agents()            List available genome roles
list_team_agents()                 List agents in current team
create_agent(genomeRef, context?)  Spawn new agent
kill_agent(sessionId)              Terminate agent
compact_agent(sessionId)           Trigger context compaction
score_agent(sessionId, score, rationale)   Score 0-10
score_supervisor_self(score, rationale)
update_genome_feedback(genomeRef, feedback)
create_genome(spec)                Create new genome definition
```

### Logs & Diagnostics

```
read_cc_log(sessionId?, limit?)    Read Claude Code log
list_team_cc_logs()                List all CC logs
list_team_runtime_logs()           List all runtime logs
read_runtime_log(logId)            Read specific log
```

### Coordination

```
request_help(description, context?)   Escalate to help-agent
save_supervisor_state(state)
```

---

## CLI Commands Quick Reference

```bash
# Auth
aha auth login / logout

# Vendor API keys
aha connect claude / codex / list / remove <vendor>

# Teams
aha teams list [--json]
aha teams show <id> [--json]
aha teams create --name "name" [--id "id"]
aha teams rename <id> <name>
aha teams archive <id> [--force]
aha teams delete <id> [--force]
aha teams batch-archive <id...> [--ids "a,b"]
aha teams members <id>
aha teams add-member <teamId> --session <sid> --role <role>
aha teams remove-member <teamId> --session <sid>

# Tasks
aha tasks list --team <id> [--status <s>] [--json]
aha tasks create --team <id> --title "..." [--priority high]
aha tasks update <taskId> --team <id> [--status done] [--assignee <sid>]
aha tasks start/complete <taskId> --team <id>
aha tasks delete <taskId> --team <id> [--force]

# Agents
aha agents list [--active] [--team <id>] [--role <r>]
aha agents show <sid>
aha agents update <sid> [--name ...] [--role ...] [--team ...]
aha agents archive/delete <sid> [--force]

# Ralph loop
aha ralph start --team <id> --prd prd.json
aha ralph status/stop --team <id>

# Utilities
aha doctor [clean]
aha notify -p "message"
aha daemon list / stop <sid>
```

---

## Common Patterns

### Agent Task Loop

```
list_tasks()
  → myTasks not empty → start_task(id) → work → complete_task(id) → loop
  → myTasks empty     → send_team_message("🟢 Ready") → wait
```

### Spawn and Register Agent

```
create_agent("@official/builder:1", { teamId, repoRoot })
→ agent joins team, registers session
→ list_team_agents() to verify
```

### Report a Blocker

```
report_blocker(taskId, "Cannot access DB: connection refused")
request_help({
  description: "DB connection blocked",
  context: "tried X, Y, Z"
})
```

### Score an Agent

```
score_agent(sessionId, 8, "Completed task on time, clean code, good tests")
```

---

## Full Documentation

- **Agent guide** (internal): `docs/aha-v3-agent-guide.md`
- **CLI reference** (external): `docs/aha-v3-cli-reference.md`
- **Agent JSON schema**: `schemas/agent-json-v1.schema.json`
- **Materializer spec**: `docs/agent-runtime-materializer-v1.md`
