# Supervisor / Help-Agent 日志读取指南

> 更新时间：2026-03-20  
> 适用对象：`supervisor`、`help-agent`、修复评分循环的实现者

## 1. 先记住结论

**不要把 Aha sessionId 直接传给 `read_cc_log`。**

Claude 原始日志文件是按 **Claude 本地 sessionId (`claudeLocalSessionId`)** 命名的；  
而 team / board / agents 面板里看到的通常是 **Aha sessionId**。

如果直接这样调用：

```json
{
  "sessionId": "cmmyh8z7300zks2lfoc63ie0h",
  "fromByteOffset": 0,
  "limit": 80
}
```

就很容易得到：

```text
Error reading CC log: Error: No Claude log found for session cmmyh8z7300zks2lfoc63ie0h
```

根因不是日志不存在，而是 **ID 用错了**。

---

## 2. 三种 ID / 日志源不要混

### Aha sessionId
- 来源：`list_team_agents`、team log、任务面板
- 用途：标识一个 team 内成员
- 例子：`cmmyh3whu00das2lf485wp2vo`

### Claude local sessionId
- 来源：`list_team_runtime_logs` 或 `list_team_cc_logs`
- 用途：定位 Claude Code 原始 transcript 文件
- 日志文件：`~/.claude/projects/**/<claudeLocalSessionId>.jsonl`

### Codex sessionId
- 当前实现里，Codex transcript 查找通常直接用 **Aha sessionId**
- 日志文件：
  - 全局历史：`~/.codex/history.jsonl`
  - 单 session transcript：`~/.codex/sessions/YYYY/MM/DD/rollout-*-<sessionId>.jsonl`

---

## 3. 正确顺序（推荐流程）

### Step 0：先看 team 层发生了什么

```text
read_team_log(teamId, fromCursor)
list_team_agents()
```

用途：
- 看 claim / handoff / task-update
- 确认哪些 agent 还活着
- 确认 sessionId、role、specId

### Step 1：先建立运行时日志映射

**推荐先调：**

```text
list_team_runtime_logs(teamId)
```

它会返回每个 agent 的：
- `ahaSessionId`
- `runtimeType`
- `claudeLocalSessionId`（Claude 才有）
- `logFilePath`
- `historyFilePath`（Codex history）

这是最通用的入口，因为它同时覆盖 **Claude + Codex**。

### Step 2：按 runtimeType 读取日志

#### Claude agent

优先使用统一接口：

```text
read_runtime_log(
  runtimeType: "claude",
  sessionId: <claudeLocalSessionId>
)
```

也可以使用 Claude 兼容别名：

```text
list_team_cc_logs(teamId)
read_cc_log(sessionId: <claudeLocalSessionId>)
```

> 注意：这里传入的仍然是 `claudeLocalSessionId`，不是 Aha sessionId。

#### Codex agent

先读全局历史：

```text
read_runtime_log(runtimeType: "codex", logKind: "history")
```

再按需要读单个 session transcript：

```text
read_runtime_log(
  runtimeType: "codex",
  logKind: "session",
  sessionId: <ahaSessionId>
)
```

---

## 4. 一句话版正确调用顺序

```text
read_team_log
→ list_team_agents
→ list_team_runtime_logs
→ Claude: read_runtime_log(runtimeType:"claude", sessionId:<claudeLocalSessionId>)
→ Codex:  read_runtime_log(runtimeType:"codex", logKind:"history"|"session")
→ team claims × raw logs 交叉验证
```

如果你明确要用 `read_cc_log`，补一层 Claude-only 映射：

```text
list_team_cc_logs
→ read_cc_log(sessionId:<claudeLocalSessionId>)
```

---

## 5. 常见错误模式

### 错误 1：把 Aha sessionId 传给 `read_cc_log`

```text
read_cc_log(sessionId:"cmmy...")
```

结果：
- `No Claude log found for session ...`

### 错误 2：Claude 用错 `read_runtime_log` 的 sessionId

```text
read_runtime_log(runtimeType:"claude", sessionId:"cmmy...")
```

结果同样会找不到文件。

### 错误 3：只看 team messages 就打分

不够。Supervisor 必须做：
- team log claim
- Claude/Codex 原始日志
- task 状态 / board 更新

三者交叉验证。

---

## 6. 原始文件位置（出问题时直接看）

### Team log

```text
~/.aha/teams/<teamId>/messages.jsonl
```

### Claude raw log

```text
~/.claude/projects/**/<claudeLocalSessionId>.jsonl
```

### Codex global history

```text
~/.codex/history.jsonl
```

### Codex raw session transcript

```text
~/.codex/sessions/YYYY/MM/DD/rollout-*-<sessionId>.jsonl
```

---

## 7. Supervisor 评分循环里的推荐读法

### 最小闭环

```text
read_team_log
→ list_team_agents
→ list_team_runtime_logs
→ 逐个 read_runtime_log / read_cc_log
→ 对比 claim vs evidence
→ score_agent
→ update_genome_feedback
→ save_supervisor_state
```

### 判分时至少回答 3 个问题

1. agent 说自己做了什么，raw log 里真的发生了吗？  
2. agent 有没有真正调用相关工具 / bash / 编辑文件？  
3. agent 的 claim、task 状态、team message 是否一致？

---

## 8. 当前实现建议

- **默认推荐**：`list_team_runtime_logs` + `read_runtime_log`
- **Claude 兼容路径**：`list_team_cc_logs` + `read_cc_log`
- **永远不要**假设 Aha sessionId = Claude local sessionId

如果修 Supervisor genome / prompt，请把下面这句话直接写进去：

> 读取 Claude 原始日志前，先通过 `list_team_runtime_logs(teamId)` 或 `list_team_cc_logs(teamId)` 拿到 `claudeLocalSessionId`；禁止直接用 Aha sessionId 调 `read_cc_log`。

