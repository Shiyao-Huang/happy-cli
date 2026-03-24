# CLI Team 控制流程完整性审计（2026-03-22）

## 范围

目标：审计 `cc-aha-cli-v3@2.0.2` 的 CLI 命令体系，重点验证 team 生命周期控制链路：

1. team create / show / status / members / spawn / archive / delete
2. agents create / show / list
3. sessions show / list
4. tasks create / list / start / complete / show
5. daemon / auth / trace / usage / roles / connect / ralph / codex 的命令面可达性

## 审计环境

- 机器：本地 macOS
- Node：22.22.1（通过 `fnm exec --using=22`）
- npm registry：`cc-aha-cli-v3@2.0.2` 已存在
- 审计二进制：
  - **推荐审计路径**：`$(npm prefix -g)/bin/aha-v3`（fnm Node 22 全局安装）
  - **发现问题**：shell `PATH` 中 `/opt/homebrew/bin/aha-v3` 优先级更高，仍指向旧的 2.0.1

## 关键安装结论

| 项目 | 结果 | 说明 |
|---|---|---|
| `npm install -g cc-aha-cli-v3@2.0.2` | ✅ | 安装成功 |
| `npm list -g cc-aha-cli-v3` | ✅ | 显示 2.0.2 |
| `package.json`（fnm 全局安装目录） | ✅ | 版本是 2.0.2 |
| 默认 `aha-v3 --version` | ⚠️ | 实际输出 2.0.1，因为 PATH 先命中 `/opt/homebrew/bin/aha-v3` |
| `daemon status` | ⚠️ | 运行中的 daemon 仍是 2.0.1，说明系统存在旧/新 CLI 并存 |

### 结论

**安装本身成功，但默认 PATH/daemon 环境混用 2.0.1 与 2.0.2。**
这会直接影响 CLI 审计与真实用户使用结果，属于高优先级环境一致性问题。

---

## 命令面审计

### A. 根命令面

| 命令 | 结果 | 说明 |
|---|---|---|
| `aha-v3 --help` | ⚠️ | 可用，但帮助文本仍显示旧版命令清单/版本（2.0.1 视图） |
| `aha-v3 --version` | ⚠️ | 默认 PATH 下输出 2.0.1，不符合刚安装的 2.0.2 |

### B. 子命令帮助可达性

| 命令组 | 结果 | 说明 |
|---|---|---|
| `teams --help` | ✅ | 帮助完整 |
| `agents --help` | ✅ | 帮助完整 |
| `sessions --help` | ✅ | 帮助完整 |
| `tasks --help` | ✅ | 帮助完整 |
| `roles --help` | ✅ | 帮助完整 |
| `usage --help` | ✅ | 帮助完整 |
| `trace --help` | ✅ | 帮助完整 |
| `daemon --help` | ✅ | 帮助完整 |
| `auth --help` | ✅ | 帮助完整 |
| `connect --help` | ✅ | 帮助完整 |
| `ralph --help` | ✅ | 帮助完整 |
| `codex --help` | ⚠️ | 触发 Codex skill loader 错误，不是干净的帮助输出 |

### C. 别名命令

| 别名 | 结果 | 说明 |
|---|---|---|
| `team status ...` | ✅ | 正常工作 |
| `task list ...` | ✅ | 正常工作 |
| `agent` / `session` 别名 | 未深测 | 源码已注册，未逐条执行 |

---

## 生命周期实测

> 审计中创建了 3 组测试资源：
> - Team A: `8fbf73d1-aa65-4528-ab74-112c7cdc2a56`（用于 create/agent/task/archive 测试，**被 archive 后无法恢复/删除，暴露缺陷**）
> - Team B: `ec73ba0a-7ecb-423d-a174-bb347a6f7790`（用于隔离环境下的 agent create / team delete，已删除）
> - Team C: `0949eaa6-a71a-4d5c-b81c-605981dea98d`（用于 `teams spawn --preset minimal`，已删除）

### 1) Team create → show → status

| 步骤 | 结果 | 说明 |
|---|---|---|
| `teams create --name ... --goal ... --json` | ✅ | 正常返回 team JSON |
| `teams show <teamId> --json` | ✅ | 返回 team/member/taskCount |
| `teams status <teamId> --json` | ✅ | 返回任务摘要和 goal task |
| `teams members <teamId> --json` | ✅ | 在有成员后可列出 roster |

### 2) Agent create / show / sessions show

| 步骤 | 结果 | 说明 |
|---|---|---|
| `agents create --role implementer --team <teamId> --model codex` | ✅ | 可成功 spawn Codex agent |
| `agents show <sessionId> --json` | ✅ | 可看见 metadata、flavor、runtime |
| `sessions show <sessionId> --json` | ✅ | 可看见 session 明细 |

#### 关键缺陷：team 参数被环境变量污染

第一次执行 `agents create --team <新 team>` 时，当前 shell 带有：
- `AHA_ROOM_ID=4921cddc-2e5d-4669-85e1-a96e2e40b7de`
- `AHA_TEAM_MEMBER_ID=...`

结果：
- `teams show <新 team>` 中 member roster 显示该 agent 已加入新 team
- 但 `agents show <sessionId>` / `sessions show <sessionId>` 中 `metadata.teamId` **仍写成旧 team `4921...`**

这意味着：
- **`--team` 没有稳定覆盖父环境的 `AHA_ROOM_ID`**
- team 注册和 session metadata 可能出现分裂

在 **清空 `AHA_ROOM_ID/AHA_TEAM_MEMBER_ID/...` 环境后** 再执行一次 `agents create`，metadata.teamId 恢复正确。

**结论：`agents create --team` 在 team 内嵌套调用场景下存在环境污染问题。**

### 3) Tasks create → list → start → complete → show

| 步骤 | 结果 | 说明 |
|---|---|---|
| `tasks create --team ... --assignee <sessionId>` | ✅ | 创建成功 |
| `tasks list --team ... --json` | ✅ | 能列出 goal task + 新 task |
| `tasks start <taskId> --team ... --session <sessionId>` | ✅ | 状态变 `in-progress`，executionLinks 正确创建 |
| `tasks complete <taskId> --team ... --session <sessionId>` | ✅ | 状态变 `done`，executionLinks 变 completed |
| `tasks show <taskId> --team ... --json` | ✅ | comment / status history 正常 |

### 4) Teams spawn（one-command bootstrap）

| 步骤 | 结果 | 说明 |
|---|---|---|
| `teams spawn --preset minimal --model codex --json` | ⚠️ | 功能上能创建 team + 2 个 agents（master/builder） |
| `teams show <spawnedTeam>` | ✅ | team 中可见 2 个成员 |
| `teams delete <spawnedTeam> --force --json` | ✅ | 可清理 spawned team |

#### 关键缺陷：`--json` 输出不是单一 JSON 文档

`teams spawn --json` 实际输出了 **两个拼接的 JSON 对象**：
1. team create 结果
2. spawn 结果

因此：
- 人看还行
- **机器解析会直接 `JSONDecodeError: Extra data`**

这使 `--json` 形态对脚本/自动化不可靠。

### 5) Teams archive / unarchive / delete

| 步骤 | 结果 | 说明 |
|---|---|---|
| `teams archive <teamId> --force --json` | ⚠️ | 返回 success，`archivedSessions: 2` |
| `teams unarchive <teamId>` | ❌ | 返回 404 |
| `teams show <archivedTeamId>` | ❌ | 返回 not found |
| `teams delete <archivedTeamId> --force` | ❌ | 返回 404 |
| `teams delete <activeTeamId> --force` | ✅ | 在未 archive 的 team 上正常工作 |

#### 结论

**archive 流程存在严重生命周期断裂：**
archive 后 team 从常规视图消失，但 unarchive / show / delete 都无法再找回该 team。
这说明 “create → manage → archive → restore” 的闭环 **当前未打通**。

### 6) Sessions / Agents list 按 team 过滤

| 步骤 | 结果 | 说明 |
|---|---|---|
| `agents list --team <teamId>` | ⚠️ | 行为依赖 metadata.teamId，若前面被环境污染，会列不出目标 agent |
| `sessions list --team <teamId>` | ⚠️ | 同上 |
| `agents list --role implementer` | ✅ | 可通过 role 找到目标 agent |

#### 结论

**team filter 本身不是坏的，问题在于 agent metadata.teamId 可能在 create 阶段被父环境污染。**
一旦 metadata 写错，后续按 team 查询就会出现“team roster 看得见，session/agent list 看不见”的错觉。

### 7) Daemon commands

| 步骤 | 结果 | 说明 |
|---|---|---|
| `daemon status` | ⚠️ | 能输出状态，但显示 daemon 仍是 2.0.1 |
| `daemon list --json` | ⚠️ | 返回 “No active sessions this daemon is aware of”，与实际 daemon-spawned sessions 不符 |

#### 结论

daemon 控制面在混合版本环境中可读性较差，`daemon list` 与实际存在的 daemon-spawned sessions 不一致。

---

## 总结评级

### 可用（✅）
- `teams create/show/status/members`
- `tasks create/list/start/complete/show`
- `agents create/show`
- `sessions show`
- `teams delete`（针对未 archive 的 team）
- `teams spawn`（功能层面）

### 有风险但可用（⚠️）
- `aha-v3 --version` / `aha-v3 --help`（受 PATH/旧包影响）
- `codex --help`（受 Codex skills 环境影响）
- `teams spawn --json`（输出不是单 JSON）
- `agents create --team`（在已有 `AHA_ROOM_ID` 的 shell 中会被污染）
- `agents list --team` / `sessions list --team`（依赖 metadata 正确性）
- `daemon status` / `daemon list`

### 不可接受（❌）
- `teams archive -> unarchive` 生命周期
- archived team 的 `show/delete`

---

## 最重要的 5 个结论

1. **2.0.2 安装成功，但默认 PATH 仍可能先命中旧的 2.0.1。**
2. **`agents create --team` 在 team 内 shell 环境下会被 `AHA_ROOM_ID` 污染。**
3. **`teams spawn --json` 不是可机器解析的单 JSON 输出。**
4. **`teams archive -> unarchive` 当前闭环是坏的。**
5. **daemon 控制面与真实 session 状态存在可观测性偏差。**

---

## 建议优先级

### P0
- 修复 `teams archive / unarchive / archived delete/show`
- 修复 `agents create --team` 对 `AHA_ROOM_ID` 的优先级问题

### P1
- 修复 `teams spawn --json` 为单一 JSON 文档
- 修复 PATH/版本混用提示（至少在启动时检测并警告）
- 修复 `daemon list` 的可观测性一致性

### P2
- 清理 `codex --help` 对外部 skills 环境的脆弱依赖
- 将根帮助页与真实命令注册保持一致（避免遗漏 command group）

