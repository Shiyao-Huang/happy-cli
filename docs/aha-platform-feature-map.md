# Aha Platform 完整功能 Map

> 生成时间：2026-03-19  
> 目的：把当前 Aha 平台已经存在的能力，按 **产品面 / 控制面 / 运行时 / 市场面** 做一次跨仓库整图梳理，便于后续验证、演示、回归排查与 roadmap 规划。

---

## 1. 平台范围（本次功能 Map 覆盖）

| 面向 | 仓库 / 模块 | 角色 |
|---|---|---|
| 用户产品面 | `kanban/` | Expo 客户端，承载 Teams / Agents / Sessions / Artifacts / Settings / Zen / Terminal Connect 等主要 UI |
| 运行时与 CLI | `aha-cli/` | Aha CLI、daemon、session/agent/team/task 命令面、Claude/Codex runtime、agent.json 物化与启动 |
| 后端控制面 | `happy-server/` | Fastify API、鉴权、team/task/session/agent/artifact/connect/evolution 等统一服务 |
| Marketplace / Genome Registry | `genome-hub/` | public genome / corps 市场、搜索、fork/clone/promote/favorite/feed back |
| 浏览器能力扩展 | `bb-browser/` | 真实浏览器驱动、CLI/MCP/daemon/extension、网站 adapter 生态 |

**结论**：Aha 不是单一 App，而是一个由 **移动/网页客户端 + CLI/runtime + server control plane + genome marketplace + browser capability layer** 组成的多面平台。

---

## 2. 平台分层图

```text
用户/团队
  ├─ Kanban App (Expo / Web / Mobile)
  ├─ Aha CLI
  ├─ Genome Hub (marketplace)
  └─ bb-browser (internet access layer)

控制面
  ├─ happy-server API
  ├─ team / task / session / agent / artifact / connect / evolution routes
  └─ websocket + monitoring + auth + permission interceptor

运行时
  ├─ Claude runtime
  ├─ Codex runtime
  ├─ daemon / session orchestration
  ├─ agent workspace materializer / agent.json
  └─ skills / hooks / MCP / runtime-lib

进化层
  ├─ genomes / corps
  ├─ supervisor / help-agent / org-manager
  ├─ scores / reviews / feedback / repair signals
  └─ bypass agents / leases / lineage
```

---

## 3. 核心功能域总表

| 功能域 | 主要入口 | 后端/运行时支撑 | 当前可见能力 |
|---|---|---|---|
| 账号与连接 | `kanban` 首页、设置、Terminal Connect；`aha auth` / `aha connect` | `authRoutes` / `connectRoutes` / `accountRoutes` / `machinesRoutes` | 登录、恢复账号、设备注册、供应商 token 连接、GitHub OAuth、终端连接 |
| Sessions | `kanban` 会话页 / 最近会话；`aha sessions` / `aha agents` | `sessionRoutes`、runtime metadata、daemon | 会话列表、详情、删除、归档、recent history、模型/上下文窗口信息 |
| Teams | `kanban /teams`、`/teams/new`；`aha teams` | `teamManagementRoutes` / `teamMessagesRoutes` / `teamContextRoutes` | 创建团队、成员管理、批量归档/删除、team chat、team context、状态信号 |
| Tasks / Kanban | Team detail、task modals；`aha tasks` | `taskRoutes` | task CRUD、start/complete、approval、blocker、execution links |
| Agents | `/agents`、`/agents/new`；`aha agents` | `agentRoutes` / runtime / materializer | agent session CRUD、rename/update、spawn、model override、team registration |
| Evolution / Genome | `/agents` marketplace、Team detail EvolutionSection、Genome Hub | `evolutionRoutes` + `genome-hub` | genome CRUD、publish/versioning、bypass agents、repair signals、supervisor state、lineage/scorecard |
| Marketplace / Corps | `/agents` market；Genome Hub `/genomes` `/corps` | genome-hub storage + search ranking | 搜索、收藏、fork/clone、download/spawn 计数、requirement-based genome 草拟、corps 模板 |
| Artifacts / Feed | `/artifacts`；Feed API | `artifactsRoutes` / `feedRoutes` | artifact 列表、详情、创建、更新、删除，活动 feed |
| Server / Infra | `/server`、CLI daemon | `versionRoutes` / monitoring / rate limit / websocket | 服务切换、版本、监控、metrics、daemon、本地 agent 启动链路 |
| Usage / Observability | `/settings/usage`、埋点、commerce events | `accountRoutes` usage query / `commerceObservabilityRoutes` / `track/index.ts` | 使用量统计、事件追踪、商业事件观测 |
| Browser Capability | bb-browser CLI / MCP | daemon + extension + adapter ecosystem | 真实浏览器登录态访问、网站 CLI adapter、抓包、截图、自动化 |

---

## 4. 用户产品面：`kanban/` 信息架构

### 4.1 顶级路由（`kanban/sources/app`）

| 路由 | 能力 |
|---|---|
| `/` | 首页 / Landing / Session Control 入口 |
| `/agents`、`/agents/[id]`、`/agents/new` | Agent 市场、我的 agents、agent 详情、创建入口 |
| `/teams`、`/teams/[id]`、`/teams/new` | 团队列表、团队详情、Create Team |
| `/session/[id]`、`/session/recent` | 单会话视图、最近会话历史 |
| `/artifacts`、`/artifacts/[id]`、`/artifacts/new` | 工件列表、详情、创建 |
| `/settings/*` | account / appearance / features / language / usage / voice |
| `/zen/*` | Zen 工作区 / 新建 / 查看 |
| `/terminal/*` | 终端连接确认流 |
| `/server` | 自定义 server URL 配置与校验 |
| `/restore/*` | 账号恢复流程 |
| `/machine/[id]`、`/user/[id]` | 机器/用户详情视图 |
| `/dev/*` | 开发调试页、视觉调试、日志、purchases、tests 等 |

### 4.2 关键产品模块

#### A. Sessions 面
- 组件集中在 `sources/components/session/`
- 主要能力：
  - 会话列表 / 紧凑列表 / 最近会话
  - ChatList / MessageView / CodeView / CommandView
  - AgentInput + autocomplete + suggestion view
  - Git 状态展示：`CompactGitStatus`、`ProjectGitStatus`、`GitStatusBadge`
  - SessionTypeSelector
- 说明：这意味着 Aha 的会话面不只是聊天窗口，而是 **带 git/project/status 上下文的 agent 工作台**。

#### B. Teams 面
- 组件集中在 `sources/components/team/`
- 当前能力：
  - `TeamChatRoom`：团队消息流
  - `TeamSessionSidebarPanel`：团队成员侧栏
  - `NewTaskModal` / `TaskDetailModal` / `TaskApprovalModal`
  - `TeamStatusBar`：基于 tasks 计算 running / deciding / blocked 信号
- 说明：Teams 已经具备 **多人协作 / task lifecycle / 审批 / blocker / 状态信号** 的完整基础骨架。

#### C. Agents / Marketplace 面
- `/agents/index.tsx` 已包含：
  - Marketplace / Mine 双视图
  - market / favorites / mine source tabs
  - agent / corps tabs
  - category filter：`all / coordination / support / execution`
  - genome 收藏、评分展示、spawn/download/star 指标展示
- 说明：客户端层面已经有了 **agent 市场浏览器 + 自有 agent 库 + corps 模板浏览**。

#### D. Settings 面
- 组件集中在 `sources/components/settings/`
- 当前能力：
  - ConnectButton / OAuthView
  - PermissionModeSelector
  - EvolutionSection
  - Usage / Language / Voice / Appearance / Features / Account
  - UpdateBanner
- 说明：Settings 已不是纯偏好页，而是 **连接配置 + 权限模式 + 进化状态 + 使用量** 的控制面入口。

#### E. Create Team 流程
- `teams/new.tsx` 显示：
  - 支持 team name、creation mode、goal prompt
  - 机器选择、已有 session 选择
  - role library / role counts
  - agent preference：`claude` / `codex` / `mixed`
  - genome 获取（`fetchGenomeByName`）
- 说明：Create Team 已经是 **团队装配器 / roster builder**，不是简单表单。

### 4.3 客户端同步与数据平面（`kanban/sources/sync`）

`sync/` 已覆盖：
- agents / artifacts / evolution / feed / friends / github / kv / push / services / socket / team management / usage
- encryption：artifact/session/machine 级别加密
- reducer：activity 累积、machine activity、message→event 转换、trace
- storage / persistence / settings / purchases / revenueCat
- git 解析：branch / diff / status / statusV2

**结论**：客户端不是薄 UI，而是带有 **本地加密存储 + event reducer + socket + git 状态同步 + 付费/usage/analytics** 的厚客户端。

### 4.4 埋点覆盖（`kanban/sources/track/index.ts`）

当前事件已覆盖：
- 账号：create / restore / logout
- connect：attempt / success / failure
- message / voice session
- paywall：present / click / purchase / cancel / restore / error
- review prompt
- team：create / view / task create / task approval / chat sent / task complete / task moved
- agents：page viewed / agent deployed
- session：create / activated / token usage
- 风险类：conflict detected / agent scope violation / task feedback

这说明产品已经具备 **从 acquisition → collaboration → monetization → governance** 的基础观测埋点框架。

---

## 5. CLI / Runtime 面：`aha-cli/`

### 5.1 CLI 顶层命令

来自 `aha-cli/src/index.ts`：

| 命令 | 作用 |
|---|---|
| `doctor` | 诊断 / 清理 stray processes |
| `auth` | 登录 / 登出 |
| `connect` | 连接 Codex / Claude / Gemini 等供应商 |
| `tasks` | task 管理 |
| `teams` | team 管理 |
| `agents` | agent session 管理 |
| `sessions` | session 直接管理 |
| `roles` | 角色池 / review / team-score |
| `codex` | 启动 team collaboration mode |
| `ralph` | autonomous loop |
| `notify` | push 通知 |
| `daemon` | 背景服务管理 |

### 5.2 关键命令面能力

#### A. `aha tasks`
- `list / show / create / update / delete / start / complete`
- 支持：priority、labels、approval-status、parent task、assignee、reporter
- 对应的是一个 **完整 task lifecycle CLI**，不是只读面。

#### B. `aha teams`
- `list / show / create / members / add-member / remove-member / rename / archive / delete / batch-*`
- 成员支持字段：`role` / `name` / `session-tag` / `spec-id` / `parent-session` / `execution-plane` / `runtime-type`
- 说明：team 不只是 artifact，而是 **显式 roster + session metadata sync + daemon session cleanup**。

#### C. `aha agents`
- `list / show / update / rename / archive / delete / spawn`
- `update` 支持：`name / role / team / session-tag / summary / path / model / fallback-model`
- `spawn <agent.json>` 支持：本地 materialize 后启动，并可注册进 team
- 说明：CLI 已具备 **agent session CRUD + model control plane + JSON 驱动 spawn**。

#### D. `aha sessions`
- `list / show / archive / delete`
- `show` 可展示 `resolvedModel` / `contextWindowTokens`
- 说明：session 层已具备 **模型自知与管理视图**。

#### E. `aha connect`
- `list / remove / codex / claude / gemini`
- 供应商 token 存云端，由 server 代管
- 说明：CLI 是 Aha 多模型接入的 **用户侧配置入口**。

#### F. `aha roles`
- `defaults / list / pool / reviews / review / team-reviews / team-review / team-score`
- 说明：角色池与公开评价体系已经成形。

### 5.3 Runtime / Session / Materializer 能力

基于本轮已有代码与 `docs/sprint-2026-03-18-deliverables.md`：
- Claude / Codex runtime 都已接入 team/session 体系
- `settingsPath`、`effectiveCwd`、workspace materialization 主链路已接通
- `.genome/spec.json`、`lineage.json`、`eval-criteria.md` 可注入 workspace
- runtime-lib 支持 shared resource symlink / private resource copy
- `aha agents update --model --fallback-model` + MCP `update_agent_model`
- session metadata 包含 `resolvedModel` / `contextWindowTokens`

**结论**：`aha-cli` 已经是 Aha 的 **本地 agent orchestration runtime**，不仅是一个命令壳。

---

## 6. Server 控制面：`happy-server/`

### 6.1 基础设施能力

`happy-server/sources/app/api/api.ts` 显示 server 具备：
- Fastify + Zod typed routes
- CORS / rate limiting
- Swagger `/docs`
- monitoring / metrics
- authentication
- permission interceptor
- websocket/socket 启动

### 6.2 API 路由能力分组

| 路由组 | 关键接口 | 能力 |
|---|---|---|
| Auth | `/v1/auth*` | 登录、重连、request/response、账号绑定 |
| Account | `/v1/account/profile` `/settings` `/usage/query` | 账户信息、设置、usage 查询 |
| Connect | `/v1/connect/*` | GitHub OAuth、vendor token 注册/删除/查看 |
| Sessions | `/v1/sessions` `/v2/sessions` `/messages` `/metadata` | session 列表、详情、创建、消息、metadata 更新 |
| Agents | `/v1/agents` `/:id/promote` | agent CRUD、promote |
| Teams | `/v1/teams` `/members` `/archive` `/rename` `/batch-*` | team CRUD、成员管理、批量操作 |
| Team Messages | `/v1/teams/:teamId/messages` | 团队消息流 |
| Tasks | `/v1/teams/:teamId/tasks*` | task CRUD、start、complete、report blocker、resolve blocker |
| Team Context | `/v1/teams/:teamId/context` | 团队上下文 get/put/patch/delete |
| Evolution | `/v1/teams/:teamId/bypass-agents` `/repair-signals` `/supervisor-state` `/v1/genomes*` | bypass agents、repair 信号、supervisor state、genome CRUD/version/publish |
| Artifacts | `/v1/artifacts*` | artifact CRUD |
| Feed | `/v1/feed` | feed 列表 |
| KV | `/v1/kv*` | key-value 存储 |
| Machines | `/v1/machines*` | 机器注册与查询 |
| Push | `/v1/push-tokens*` | push token 管理 |
| Voice | `/v1/voice/token` | voice token |
| Access Keys | `/v1/access-keys/:sessionId/:machineId` | 访问密钥管理 |
| Commerce Observability | `/v1/observability/commerce-events` | 商业事件观测 |
| Version / Dev | `/v1/version` / dev logs endpoint | 版本与开发调试 |

### 6.3 Server 在平台中的职责

happy-server 实际承担 4 类核心职责：
1. **业务 API 网关**：把移动端 / CLI / runtime 的所有核心对象统一落盘与读取。  
2. **team collaboration 状态机**：team、task、session、message、blocker、approval、team context 都在这里汇总。  
3. **evolution control plane**：genome、bypass agent、repair signals、supervisor state 都经由 server 暴露。  
4. **安全边界**：auth、permission interceptor、rate limit、access keys、vendor token 管理。

---

## 7. Evolution / Genome / Marketplace 面

### 7.1 `happy-server` 里的 evolution API

当前已经具备：
- bypass agents 列表与 retire
- repair signals 列表
- supervisor state 摘要
- genomes CRUD
- latest / versions / pinned version 读取
- publish genome

### 7.2 `genome-hub/` 里的 public marketplace

Genome Hub 当前能力：
- `GET /genomes`：搜索公共 genome
- `POST /genomes/from-requirement`：按 requirement 生成/推荐 genome 草案
- `GET/PATCH/DELETE /genomes/id/:id`
- `POST /genomes/id/:id/spawn` / `download`
- 收藏：favorite / unfavorite / favorites
- `fork` / `clone`
- `GET /genomes/:namespace/:name` + `versions` + pinned version
- `POST /genomes/:namespace/:name/promote`
- `GET/POST /corps`
- `GET /namespaces/:namespace`
- `PATCH /genomes/:namespace/:name/feedback`

### 7.3 AgentImage 已承载的信息

`genome-hub/src/types/genome.ts` 显示 `AgentImage`（兼容旧 `GenomeSpec` 读路径）已不是简单 prompt，而是完整 agent DNA：
- identity：displayName / baseRoleId / namespace / version / category / tags
- runtime：runtimeType / modelId / fallbackModelId / modelProvider
- tools：allowed/disallowed tools、MCP、skills、hooks
- behavior：messaging / onIdle / onBlocked / canSpawnAgents / requireExplicitAssignment
- memory：session / persistent / shared learnings
- scope：ownedPaths / forbiddenPaths / outOfScope
- validation：smoke tests / minVerifiedScore / minEvaluations
- resourceBudget：estimatedTokens / context size / concurrency capability
- compatibility / operations / resume / modelScores

**结论**：`AgentImage` 在 Aha 里已经等于 **可发布、可评分、可继承、可运行的 agent package**。

### 7.4 Official seed 能力

`seedOfficialGenomes.ts` 说明官方市场已内置：
- `@official/supervisor`
- `@official/help-agent`
- `@official/org-manager`
- working roles：`master`、`implementer`、`architect`、`qa-engineer`、`researcher`
- legion/team templates：如 `fullstack-squad`、`research-pod`

也就是说，Marketplace 不只是用户上传池，已经有 **官方启动包与 team 模板**。

---

## 8. Browser Capability Layer：`bb-browser/`

bb-browser 在 Aha 体系中的角色是 **给 agent 打开“真实互联网访问层”**。

### 当前能力
- 36 平台、103 个命令的 site adapter 生态
- CLI / MCP / daemon / Chrome extension / OpenClaw 模式
- 使用用户真实浏览器登录态，不需要重做网站 API 接入
- 既支持内容访问，也支持浏览器自动化：
  - open / snapshot / click / fill / eval / fetch / network / screenshot
- 支持 `--json`、`--jq`、`--tab` 等 agent 友好参数

### 在 Aha 平台里的价值
- 让 agent 从“文件 + 终端 + 少数 API”扩展到“整个互联网”
- 可作为 research / QA / competitor intelligence / ops automation 的能力底座
- 对 Team 模式尤其重要：不同 agent 可以并行拉取不同网站的信息源

---

## 9. 关键闭环（E2E Loops）

### 9.1 Team 创建闭环
1. 用户进入 `kanban /teams/new`
2. 选择机器 / session / roles / agent preference
3. `happy-server` 建 team + member roster
4. CLI/runtime session metadata 同步到 team
5. team detail 中继续 task/chat/approval/execution

### 9.2 Agent 生命周期闭环
1. 用户或组织器通过 `aha agents spawn <agent.json>` 或 UI 选择 genome
2. `aha-cli` materialize workspace，注入 settings / skills / hooks / genome overlays
3. session 启动并注册进 team
4. 可通过 `aha agents update` / MCP `update_agent_model` 修改模型
5. `aha sessions` / UI 查看状态、summary、usage、messages

### 9.3 Task 协作闭环
1. 团队创建 task
2. agent `start_task`
3. executionLinks + in-progress 状态可见
4. approval / blocker / resolve blocker / complete
5. TeamStatusBar 聚合 deciding / running / blocked 信号

### 9.4 Evolution 闭环
1. 团队运行产生 genomes / bypass agents / repair signals / supervisor state
2. Genome Hub 负责 public market、fork/clone/promote/favorite/feed back
3. role reviews / team reviews / team score 在 CLI 侧形成评分面
4. 下一轮 team 可复用 genome / corps 模板继续启动

### 9.5 Browser-enhanced Research / QA 闭环
1. agent 在 team 内接到 research / QA 任务
2. 使用 bb-browser 访问真实网站与登录态数据
3. 产出 artifact / report / task update
4. 团队继续评审、修复、归档

---

## 10. 关键对象模型（平台脑图）

| 对象 | 说明 | 主要所在层 |
|---|---|---|
| Session | 单个运行中的 agent / 用户会话 | kanban / aha-cli / happy-server |
| Agent | session-backed agent + metadata + role/model/path | aha-cli / happy-server / kanban |
| Team | roster + board + message stream + context | kanban / happy-server / aha-cli |
| Task | board item with status / priority / approval / blocker / executionLinks | kanban / happy-server / aha-cli |
| Genome | 可复用 agent DNA package | happy-server / genome-hub / kanban |
| Corps | 多 genome 的团队模板 | genome-hub / kanban |
| Bypass Agent | 由演化/监督链路短期生成的特殊 agent | happy-server / kanban |
| Repair Signal | stuck / context_overflow / need_collaborator / error 等修复触发器 | happy-server / kanban |
| Artifact | 产物对象 | kanban / happy-server |
| Machine | 用户机器/设备 | kanban / happy-server |
| Vendor Token | Codex / Claude / Gemini 等连接凭证 | aha-cli / happy-server |

---

## 11. 现阶段平台画像（结论版）

如果把 Aha 用一句话描述，它现在更像：

> **一个让用户装配、运行、协作、评分、进化和复用 AI 团队的多端平台。**

它已经同时具备：
- **客户端产品面**：session、team、agent market、artifact、settings、terminal connect
- **CLI / runtime 面**：agent spawn、session/team/task CRUD、model control、workspace materialization
- **后端控制面**：typed API、auth、permission、team/task/session/evolution 统一存储
- **市场面**：genome/corps 的 public registry、评分、fork、promote
- **扩展能力层**：bb-browser 让 agent 访问真实互联网

### 更具体地说，Aha 当前已形成 5 条主线产品能力：
1. **Run AI**：启动和管理 session / agent / model / runtime  
2. **Organize AI**：组建 team、分配 task、审批、追踪 blocker  
3. **Evolve AI**：积累 genome、评分、marketplace、corps 模板  
4. **Observe AI**：usage、analytics、repair signals、supervisor state、team score  
5. **Extend AI**：通过 bb-browser / connect / skills / hooks 接入外部能力

---

## 12. 建议作为后续工作的 Map 用法

这份 Map 最适合用于：
- 验证 checklist 的母表
- Sprint 演示时的“平台总览图”
- 回归排查时的影响面定位
- 后续 PRD / roadmap 拆解基线
- 向外解释「Aha 到底已经有什么」时的统一口径

建议后续把新增能力继续按下面格式追加：
- 新功能域
- 新入口（UI / CLI / API / Marketplace / Runtime）
- 关键对象
- 闭环位置
- 影响仓库
