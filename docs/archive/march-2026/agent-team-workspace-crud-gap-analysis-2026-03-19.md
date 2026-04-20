# Agent / Team / Workspace CRUD 缺口分析（2026-03-19）

Scope: `aha-cli` + `happy-server` + `kanban`

参考目标：`aha-cli/docs/launch-agent-workspace-marketplace-contract-2026-03-18.md`

## TL;DR

当前状态不是“完全没做”，而是**已经有了 agent runtime / team / standalone agent 的半套控制面**，但还没有收敛成 launch contract 里要求的那条主链路。

结论：

1. **Agent workspace materializer 已打通**，这是目前最完整的一段。  
2. **Agent CRUD / Team CRUD 已存在，但仍以 artifact/session 为中心，缺少 workspace 这一层 canonical object。**  
3. **Workspace first-class resource 仍然完全缺失**：没有 Prisma model、没有 API、没有 client、没有 UI CRUD。  
4. **Kanban 与 CLI 的 team create 仍是旁路写入**，没有真正收敛到统一的 `/v1/teams` 控制面。  
5. **Marketplace/Corps → Team Template 实例化没有接上**，`teams/new` 还在用硬编码 quick templates。

---

## 1. 已经完成、可复用的部分

### 1.1 Agent workspace materializer：已完成

`aha-cli` 已经具备 agent-local workspace 物化能力，不是缺口本身。

证据：

- `aha-cli/src/agentDocker/materializer.ts:92-110` 已定义 `MaterializeAgentWorkspaceResult`，包含 `workspaceRoot`、`effectiveCwd`、`settingsPath` 等关键字段。
- `aha-cli/src/agentDocker/materializer.ts:336-409` 已生成实际 runtime workspace，并根据 shared/isolated 计算 `effectiveCwd`。
- `aha-cli/src/claude/runClaude.ts:435-445` 已在 genome 启动链路中调用 `buildAgentWorkspacePlanFromGenome(...)`。
- `aha-cli/src/claude/runClaude.ts:1531-1554` 已把 `effectiveCwd` 和 `settingsPath` 真正传给 runtime loop。

**判断**：运行时 workspace 物化主链路已存在，后续要补的是“把它变成用户可管理的 Workspace 资源”，不是重写 materializer。

### 1.2 Session / model 控制面：已完成

证据：

- `aha-cli/src/commands/sessions.ts:124-150` 已提供 `list/show/archive/delete`。
- `aha-cli/src/commands/agents.ts:564-606` 的 spawn 流程已能把 materialized env 注入 daemon，并在有 `teamId` 时回写 team roster。

**判断**：CLI 控制面已有可用底座，问题主要不在 session，而在 team/workspace 对象层。

### 1.3 Server-side standalone agent CRUD：已完成基础版

证据：

- `happy-server/sources/app/api/routes/agentRoutes.ts:16-30` 定义了 create/patch schema。
- `happy-server/sources/app/api/routes/agentRoutes.ts:87-130` 实现 `POST /v1/agents`。
- 同文件继续实现了 `GET /v1/agents`、`GET /v1/agents/:id`、`PATCH /v1/agents/:id`、`DELETE /v1/agents/:id`、`POST /v1/agents/:id/promote`。

**判断**：standalone agent CRUD 已有后端基础，但还没有 workspace-aware，也没有完整前端覆盖。

### 1.4 Server-side team CRUD：已完成基础版

证据：

- `happy-server/sources/app/api/routes/teamManagementRoutes.ts:32-70` 已有 `POST /v1/teams`。
- 同文件还实现了 list/get/member add/remove/rename/archive/delete/batch。

**判断**：team CRUD 后端已存在，但“谁是 canonical create path”仍未统一。

---

## 2. 核心缺口

### Gap A — Workspace first-class resource 完全缺失（P0）

这是当前最大的结构性缺口。

证据：

- `happy-server/prisma/schema.prisma:261-440` 存在 `Artifact`、`TeamContextEntry`、`Genome`，**没有 `Workspace` model**。
- `happy-server/sources/app/api/api.ts:150-172` 注册了 `teamManagementRoutes`、`agentRoutes` 等，但**没有任何 `workspaceRoutes`**。
- `happy-server/sources/app/api/routes/teamManagementRoutes.ts:36-39` 的 create team body 只有 `name` / `description`。
- `happy-server/sources/app/api/routes/agentRoutes.ts:16-23` 的 create agent schema 只有 `displayName`、`genomeId/spec`、`runtimeType`、`modelId`、`metadata`，**没有 `workspaceId`**。

影响：

- 机器、路径、repo identity 仍然散落在 `machineId` / `cwd` / session metadata / artifact body 里。
- 无法把 “team belongs to which workspace” 和 “standalone agent belongs to which workspace” 变成稳定引用。
- launch contract 里定义的 `/v1/workspaces`、`workspaceId` plumbing 目前没有任何落点。

建议：

1. 在 `happy-server` 先补 `Workspace` Prisma model。  
2. 增加 `/v1/workspaces` CRUD routes。  
3. 再把 `workspaceId` 接到 team create / agent create / member metadata。  

---

### Gap B — Team create 仍然是 split-brain：artifact path 与 server team path 并存（P0）

这是当前最危险的一致性问题。

证据：

- `kanban/sources/app/(app)/teams/new.tsx:967-973` 先调用 `sync.createArtifact(...)` 创建 team artifact。
- `kanban/sources/app/(app)/teams/new.tsx:975-979` 随后又单独调用 `sync.registerTeam({ name })`。
- desktop bridge 分支也是同样模式：`kanban/sources/app/(app)/teams/new.tsx:1168-1179`。
- `kanban/sources/sync/apiTeamManagement.ts:83-106` 的 `createTeam(...)` 只是 POST `/v1/teams`，body 只有 `{ name, description? }`。
- `happy-server/sources/app/api/routes/teamManagementRoutes.ts:46-70` 服务端会自己生成一个新的 `teamId`。
- 但 Kanban 后续事件与跳转仍然使用本地 `artifactId`：`kanban/sources/app/(app)/teams/new.tsx:1210-1229`。
- Teams 列表页也直接读本地 artifact：`kanban/sources/app/(app)/teams/index.tsx:586-592`。
- CLI 也没有走 `/v1/teams` create，而是直接 `api.createArtifact(...)`：`aha-cli/src/commands/teams.ts:439-479`。

影响：

- **Kanban 实际上会产生两个 team identity**：本地 artifactId 与 server random teamId。  
- UI 导航、埋点、后续 team 页面继续使用 artifactId，而 server 侧 `registerTeam()` 返回的 team 只是旁路记录。  
- 一旦后续引入 `workspaceId`、template provenance、server-side policy，当前 create path 会直接绕过。  

建议：

- 必须收敛为**单一 canonical create path**。  
- 推荐做法：`POST /v1/teams` 接收完整创建上下文（或允许客户端传 canonical id），由 server 创建 artifact/team projection，再把 canonical id 返回给 CLI/Kanban。  
- `sync.registerTeam()` 这种“create 后再补记一笔”的模式应删除。

---

### Gap C — Agent CRUD 还没有 workspace-aware，前端也没覆盖完整生命周期（P1）

证据：

- `happy-server/sources/app/api/routes/agentRoutes.ts:16-23` 没有 `workspaceId` / `machineId` / `rootPath`。
- `kanban/sources/app/(app)/agents/new.tsx:54-58` 创建 agent 时只传 `displayName`、`runtimeType`、`genomeSpec`。
- `kanban/sources/app/(app)/agents/index.tsx:384-417` “My Agents” 页面只有 list + delete，没有 update/promote/archive/resume。
- 虽然 server 端已经有 promote route，但当前 Kanban 没有对应 client/UI path。

影响：

- standalone agent 无法绑定到 canonical workspace。  
- 用户在 UI 上并不能完成完整 Agent CRUD，只能创建和删除。  
- promote-to-team 虽然 server 有能力，但实际产品流里不可达。  

建议：

1. 先给 agent create/patch 接上 `workspaceId`。  
2. Kanban “My Agents” 增加 detail / edit / archive / promote。  
3. 再考虑 CLI 是否需要补 standalone-agent create/show/promote 命令。  

---

### Gap D — Team Template / Marketplace 实例化未接通（P1）

证据：

- `kanban/sources/app/(app)/teams/new.tsx:389-422` 目前仍是硬编码 `QUICK_TEMPLATES`。  
- `kanban` Marketplace 页虽然能浏览 corps/genomes，但 create-team flow 并没有调用 `from-template`。  
- `happy-server/sources/app/api/api.ts:150-172` 的 routes 注册里也没有 `/v1/teams/from-template` 对应入口。  

影响：

- Marketplace 里的 corps / team template 目前只是“看得到”，还不是“可实例化的控制面对象”。  
- launch contract 中 “Use Team Template” 的主路径尚未落地。  

建议：

- 增加 `POST /v1/teams/from-template`。  
- `teams/new` 用 corps/template 选择替换当前 hardcoded quick templates。  
- 机器选择、cwd 输入、runtime preference 这些 UI 现成字段可以直接复用。

---

### Gap E — “Workspace” 现在更多是文案，不是资源（P1）

现状不是没有 workspace 概念，而是它仍停留在：

- machine picker
- cwd input
- local runtime materializer
- UI 文案中的 “Workspace”

但它还不是：

- 可创建 / 可列出 / 可编辑 / 可归档 的资源对象
- team / agent 可稳定引用的控制面对象
- server 可做审计、策略、模板默认值、最近启动记录的对象

**判断**：这也是为什么 launch contract 把 Workspace 定义为“main missing object”。代码现状与这个判断一致。

---

## 3. 优先级建议

### P0（先做，不然后面都容易返工）

1. **统一 canonical team create path**  
   - 让 CLI / Kanban 都走同一条 server-side team create。  
   - 消除 `createArtifact + registerTeam` 双写。

2. **引入 Workspace model + CRUD**  
   - Prisma model  
   - `/v1/workspaces` routes  
   - client API

3. **把 `workspaceId` 接入 team / agent create**  
   - `POST /v1/teams`  
   - `POST /v1/agents`  
   - team/member metadata snapshot fallback

### P1（P0 后立即跟上）

4. **补 Team Template 实例化**  
   - `/v1/teams/from-template`  
   - Kanban create-team flow 接 marketplace corps

5. **补 Agent UI lifecycle**  
   - standalone agent detail/edit/archive/promote

### P2（体验增强）

6. Workspace recent launches / activity history  
7. Template ranking / used-by count  
8. Workspace-aware dashboards / filters

---

## 4. 最短结论

如果只看“有没有基础设施”，答案是：**有，而且已经不少**。  
如果看“是否已经满足 launch contract”，答案是：**还没有，关键卡点是 Workspace 缺失 + Team create 双写分叉。**

最值得优先修的不是 UI 细节，而是这两件事：

1. **把 Team create 收敛成唯一真源**  
2. **把 Workspace 补成 first-class resource**

只要这两步完成，Agent CRUD、Template instantiation、Marketplace launch 才能自然接上，而不是继续在 artifact/session 层叠补丁。
