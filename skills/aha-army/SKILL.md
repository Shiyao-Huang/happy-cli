# /aha-army

Give any agent that supports SKILL.md (Claude Code, Codex CLI, OpenClaw) full Aha army/legion capabilities via the `aha` CLI. One-command team bootstrap, agent lifecycle management, and marketplace-based legion deployment.

Install via OpenClaw: `openclaw skill install aha-army`

---

## Prerequisites

Before running any army command, verify the aha daemon is running:

```bash
aha daemon status
```

If not running, start it:

```bash
aha daemon start
```

All army commands require the daemon. If `daemon status` returns an error, fix it before continuing.

---

## Spawn a Team (Preset)

Use a built-in preset to bootstrap a complete team in one command:

```bash
# Presets: deployment | dev | review | minimal
aha teams spawn --preset dev --name "My Dev Crew"

# Spawn to an existing team
aha teams spawn --preset dev --team <existing-teamId>

# Use codex runtime instead of claude
aha teams spawn --preset dev --model codex --name "Codex Dev Crew"

# Spawn with a specific working directory
aha teams spawn --preset deployment --path /path/to/project
```

**Available presets:**
- `deployment` — Master + DevOps Builder + QA
- `dev` — Master + Builder + Framer + Reviewer
- `review` — Master + Reviewer + QA
- `minimal` — Master + Builder only

---

## Spawn a Team (Marketplace Template)

Pull a team template from the genome marketplace and instantiate it:

```bash
# By namespace/name
aha teams spawn --template @official/gstack-squad:1 --name "gstack Squad"

# By template ID
aha teams spawn --template <templateId>

# Preview without spawning agents
aha teams spawn --template @official/fullstack-squad:1 --no-spawn
```

---

## Agent Lifecycle Management

### Kill (archive) one or more agents

```bash
# Kill a single agent
aha agents kill <sessionId>

# Kill multiple agents
aha agents kill <sessionId1> <sessionId2> <sessionId3>
```

### View agent logs

```bash
# Last 50 log entries (default)
aha agents logs <sessionId>

# Custom number of log entries
aha agents logs <sessionId> --lines 100

# JSON output
aha agents logs <sessionId> --json
```

### List active agents

```bash
# All agents in current team
aha agents list --active

# Filter by team
aha agents list --team <teamId>

# Filter by role
aha agents list --role builder
```

---

## Common Workflows

### Bootstrap a dev team and check status

```bash
aha daemon status
aha teams spawn --preset dev --name "Sprint Crew"
aha teams status
```

### Deploy from marketplace, monitor, then teardown

```bash
aha daemon status
aha teams spawn --template @official/fullstack-squad:1 --name "Fullstack Team"
# ... let agents work ...
aha teams status <teamId>
aha agents list --team <teamId>
# When done, kill all team agents
aha agents kill <sessionId1> <sessionId2>
```

### Debug a stuck agent

```bash
# View recent log
aha agents logs <sessionId> --lines 200

# If unresponsive, kill and respawn
aha agents kill <sessionId>
aha agents create --role builder --team <teamId>
```

---

## Full CLI Reference

```bash
# Daemon
aha daemon start
aha daemon stop
aha daemon status

# Teams
aha teams spawn --preset <deployment|dev|review|minimal> [--name "..."] [--team <id>] [--model claude|codex] [--path <cwd>]
aha teams spawn --template <id|@ns/name[:v]> [--name "..."] [--no-spawn]
aha teams list
aha teams show <teamId>
aha teams status [teamId]
aha teams archive <teamId> [--force]

# Agents
aha agents create --role <roleId> --team <teamId> [--name "..."]
aha agents list [--active] [--team <id>] [--role <role>]
aha agents show <sessionId>
aha agents kill <sessionId...>
aha agents logs <sessionId> [--lines N] [--json]
aha agents spawn <agent.json> [--team <teamId>] [--role <role>] [--path <cwd>]

# Auth
aha auth login
aha connect claude         # Store Claude API key
aha connect codex          # Store OpenAI/Codex API key

# Tasks
aha tasks list --team <teamId>
aha tasks create --team <teamId> --title "..."
aha tasks start <taskId> --team <teamId>
aha tasks complete <taskId> --team <teamId>
```

---

## OpenClaw Integration Notes

When using via OpenClaw (`openclaw skill install aha-army`):

1. Ensure `aha` CLI is installed and authenticated (`aha auth login`)
2. `aha daemon start` must be run before any team/agent commands
3. The restore key for machine connection can be used at login time
4. For multi-machine testing: `ssh uv1` / `ssh uv2` then run army commands on each machine
5. Each machine stores its own path cache in `~/.aha/` profile

For Claude Code / Codex CLI: this skill is discovered automatically from `.claude/skills/aha-army/` or `.agents/skills/aha-army/`.
