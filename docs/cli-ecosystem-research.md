# CLI Agent 生态调研报告

**日期**: 2026-03-20
**作者**: Builder (cmmyh8zq)
**任务**: 9UZlSlnL1ifN

---

## 一、竞品现状分析

### 🦞 OpenClaw（247K GitHub Stars，2026年最热开源 Agent）

**概述**: 彼得·施泰因贝格尔开发，原名 Clawdbot → Moltbot → OpenClaw。2026年2月突破10万 Star，目前 247K Stars / 47.7K Forks。

**核心设计理念**:
- **Bring Your Own API Key** — 不强绑服务商，自由选 Claude/GPT/DeepSeek
- **本地运行，数据自持** — 配置和历史存本地，隐私友好
- **Skills 插件系统** — 每个能力是独立脚本/模块，社区可自由贡献

**CLI 设计**:
```bash
# 单进程 Gateway 启动
openclaw start

# Skills 管理（核心差异化）
openclaw skill install <name>
openclaw skill list
openclaw skill remove <name>
```

**生态**:
- 支持 20+ 聊天频道（WhatsApp/Telegram/Discord/iMessage/Slack...）
- 100+ 预置 Skills（浏览器、文件系统、自动化、智能家居...）
- 插件仓库无严格审核 → 快速增长但有安全风险（Cisco 发现数据外泄 skill）

**安全警示**: 2026年3月中国政府限制国家机构使用，原因是提示注入风险。

**对 aha 的启示**: Skills 系统是核心竞争力；plug-in-play 降低使用门槛。

---

### 🤖 Claude Code Agent Teams（2026年实验性功能）

**启用方式**:
```bash
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

**命令体系**:
```bash
# 交互式 Agent 管理
/agents                           # 查看/创建/编辑 subagents

# CLI 方式
claude agents                     # 列出所有 subagents

# 启动时定义 agent（JSON，仅当前 session）
claude --agents '{"name":"Builder","role":"...","tools":["Bash","Read"]}'
```

**Agent 存储层级**:
| 路径 | 作用域 |
|------|--------|
| `.claude/agents/*.md` | 项目级（提交版本库共享） |
| `~/.claude/agents/*.md` | 用户级（跨项目） |
| `--agents` flag | Session 级（临时，不持久化） |

**Agent 定义格式（Markdown + YAML frontmatter）**:
```markdown
---
name: builder
description: Implements backend features
tools: [Bash, Read, Edit, Write]
---
You are a backend builder...
```

**Skills 注入**:
```yaml
skills: [python-patterns, backend-patterns]
```

**团队架构**: Team Lead（主 session）→ 派生 Teammate（独立 Claude 实例，各自 context window）

**对 aha 的启示**: `~/.aha/agents/` 持久化 + skills 字段注入 + JSON flag 临时创建。

---

### 🐳 Docker CLI 设计模式（最成熟的资源管理 CLI 范式）

**Management Commands 分层**:
```bash
# 高层别名（用户常用）
docker run nginx
docker ps

# 底层 Management Commands（脚本友好）
docker container run nginx
docker container list
```

**生命周期动词（资源状态机）**:
```
create → start → (pause / unpause) → stop → kill → rm
```

**设计原则**:
1. `create` = 准备资源但不启动（幂等）
2. `run` = create + start（便捷组合）
3. `--name` 统一标识符 — 所有资源都有 name，便于脚本引用
4. `--format` JSON 输出 — 机器可读
5. `--filter` 查询 — 按 label/status 过滤

**对 aha 的启示**:
- `aha agent create` vs `aha agent spawn`（create+start）
- 所有资源统一支持 `--json` 输出
- 生命周期：create → start → stop → kill → rm

---

### 其他竞品速览

| 工具 | 特点 | CLI 设计亮点 |
|------|------|------------|
| **CrewAI** | 角色制多 Agent 协作 | `crewai create crew`、`crewai kickoff` |
| **Codex CLI** | OpenAI 出品，代码生成 | `codex`（交互）、`codex -q "task"` |
| **Aider** | Git 深度集成 | `aider --model claude-3-5-sonnet` |
| **Goose** | Block 出品，扩展工具链 | `goose session start/resume` |
| **Amazon Q CLI** | AWS 生态集成 | `q chat`、`q agent run` |

---

## 二、aha-cli 现状盘点

### 已有命令
```bash
aha                           # 启动 Claude + QR 码 remote 控制
aha auth login/logout
aha codex                     # Codex 模式
aha daemon start/stop/status/list
aha doctor [clean]
aha notify -p "message"
aha connect                   # 存储 AI API Key

# Team/Agent 管理（v3）
aha team create --name "Sprint Crew"
aha agents list --active
aha agents create ...
aha roles list/review
aha sessions list
aha tasks list/create/done
```

### 缺失的 CLI 能力（Gap Analysis）

| 缺失命令 | 优先级 | 解决问题 |
|---------|--------|---------|
| `aha agent create --role <name> --team <id>` | **P0** | 命令行直接创建 agent + 自动注入 teamId/prompt |
| `aha agent kill/logs <sessionId>` | P0 | Agent 生命周期管理 |
| `aha team spawn --preset <name>` | **P0** | 一键拉起预设军团 |
| `aha team status [<id>]` | P1 | 实时看板状态 |
| `aha role create --file ./role.md` | P1 | 从文件创建本地角色 |
| `aha skill install/list/run <name>` | **P1** | 打通 OpenClaw Skills 生态 |
| `aha genome push/pull <role>` | P1 | 角色市场，对标 `docker push/pull` |
| `aha genome search <keyword>` | P2 | 角色市场搜索 |

---

## 三、推荐 CLI 化方案

### 命令结构（对标 Docker Management Commands）

```bash
# 角色管理
aha role create --name "DevOps" --file ./devops.md
aha role list [--public]
aha role show <name>
aha role push <name>                # 发布到 Genome Hub
aha role pull <name>                # 从 Genome Hub 拉取

# Agent 管理
aha agent create --role builder [--team <teamId>] [--name "Build-1"]
aha agent spawn --role builder --team <teamId>   # create + start
aha agent list [--team <id>] [--active]
aha agent stop <sessionId>
aha agent kill <sessionId>
aha agent logs <sessionId> [--follow]

# 军团管理
aha team create --name "Deploy Crew"
aha team spawn --name "Deploy Crew" [--preset deployment]
aha team status [<teamId>]
aha team disband [<teamId>]

# Skills 生态
aha skill install <name>            # 从 Skill Hub 安装
aha skill create --name "deploy-ssh" --file ./deploy.sh
aha skill list
aha skill run <name> [args...]

# Genome Hub（角色市场）
aha genome push <role>              # 对标 docker push
aha genome pull <role>              # 对标 docker pull
aha genome search <keyword>
aha genome list [--verified]
```

### Prompt 注入标准模板（解决子 Agent 无上下文问题）

```
aha agent create 执行时自动注入:

SYSTEM:
- Team ID: {teamId}
- Session ID: {newSessionId}
- Role: {roleName}
- On startup: call get_team_info + list_tasks
- Kanban protocol: start_task before work, complete_task after done
- Report blockers via send_team_message @master
```

### 与生态的打通方案

**OpenClaw**:
```bash
# 将 OpenClaw skill 格式适配到 aha skill
aha skill import --from openclaw <skill-name>
```

**Claude Code**:
```bash
# 导出为 Claude Code agent 格式
aha agent export <sessionId> --format claude-code > .claude/agents/builder.md

# 从 Claude Code agent 导入
aha role import --from claude-code .claude/agents/builder.md
```

**Docker 分发**:
```dockerfile
# aha agent 容器化运行
FROM node:20-alpine
RUN npm install -g cc-aha-cli
ENTRYPOINT ["aha", "agent", "spawn", "--role", "builder"]
```

---

## 四、实现优先级路线图

### Phase 1 — 核心 CLI 化（立即）
1. `aha agent create/spawn/kill` — 解决手动创建 agent 的门槛
2. `aha team spawn --preset` — 一键启动预设军团
3. 统一 prompt 注入模板 — 修复子 Agent 无上下文问题

### Phase 2 — Genome 生态
1. `aha role push/pull` — 角色版本管理
2. `aha genome search` — 角色市场搜索
3. Genome Hub API 公开文档

### Phase 3 — Skills 生态打通
1. `aha skill install/run` — Skills 包管理
2. OpenClaw Skills 格式兼容适配
3. Claude Code agent 格式双向导入导出

---

## 参考资料

- [OpenClaw GitHub](https://github.com/openclaw/openclaw)
- [OpenClaw 官网](https://openclaw.ai)
- [Claude Code Sub-Agents Docs](https://code.claude.com/docs/en/sub-agents)
- [Docker CLI Reference](https://docs.docker.com/reference/cli/docker/)
- [Top CLI AI Coding Agents 2026](https://pinggy.io/blog/top_cli_based_ai_coding_agents/)
- [Building AI Coding Agents for the Terminal](https://arxiv.org/html/2603.05344v1)
- [AWS CLI Agent Orchestrator](https://aws.amazon.com/blogs/opensource/introducing-cli-agent-orchestrator-transforming-developer-cli-tools-into-a-multi-agent-powerhouse/)
