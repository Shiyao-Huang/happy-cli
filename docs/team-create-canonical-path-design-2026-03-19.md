# P0 修复设计：统一 Team Create Canonical Path（2026-03-19）

Scope: `happy-server` + `kanban` + `aha-cli`

关联问题：`Agent/Team/Workspace CRUD 缺口分析` 中的 Gap B（team create split-brain）

---

## 1. 问题定义

当前 Team Create 不是一条路径，而是至少两条：

1. **Kanban 路径**
   - 先 `sync.createArtifact(..., type='team')`
   - 再 `sync.registerTeam({ name })`
   - 结果是本地导航/状态使用 `artifactId`，server `/v1/teams` 又生成了另一个 `teamId`

2. **CLI 路径**
   - `aha teams create` 直接 `api.createArtifact(...)`
   - 完全绕过 `/v1/teams`

3. **Server 路径**
   - `POST /v1/teams` 当前只是一个“注册 team summary”的旁路接口，不是所有 team create 的唯一真源

这会造成三个直接问题：

- **双写 / 双 ID**：Kanban 在一次创建里可能得到两个 team identity
- **控制面绕过**：CLI 直接写 artifact，未来的 `workspaceId` / template provenance / policy 都无法强制接入
- **artifact 物理格式分叉**：`/v1/artifacts` 创建的 team 与 `/v1/teams` 创建的 team，底层 envelope 和责任边界都不同

---

## 2. 设计目标

### P0 必须达成

1. **所有 first-party team create 都走同一条高层接口**
2. **一次创建只产生一个 canonical teamId / artifactId**
3. **server 成为 team create 的唯一写入口**
4. **kanban 创建后能立即导航，不依赖额外 register 补写**
5. **后续能自然接上 `workspaceId`、template、spawn policy**

### 明确非目标（本轮不做）

- 不在本轮直接引入 `Workspace` model
- 不在本轮实现 `/v1/teams/from-template`
- 不重做 session metadata 加密模型
- 不直接改 team 编辑/运行逻辑，只解决“create 入口统一”

---

## 3. 核心决策

## 决策 A：`POST /v1/teams` 成为唯一 canonical create 入口

**统一后规则：**

- `kanban` 创建 team：只能调 `POST /v1/teams`
- `aha-cli teams create`：只能调 `POST /v1/teams`
- 未来 `from-template`：内部也调用同一个 team creation service
- `POST /v1/artifacts` 仍保留给 generic artifact，但**不再允许 first-party 用它创建 `type='team'`**

### 为什么不是 `/v1/artifacts`

因为 `/v1/artifacts` 是低层存储接口，不适合作为 Team 控制面的真源：

- 它不理解 `workspaceId`
- 它不理解 team provenance / template provenance
- 它不理解成员、goal、roomId、machine snapshot 等 team 语义
- 它要求客户端知道 artifact envelope 细节，导致实现散落在多个客户端

**结论：** `/v1/artifacts` 是存储层；`/v1/teams` 才应该是 Team 控制层。

---

## 决策 B：canonical team 仍然是一个 artifact，但只能由 server 生成

Team 底层仍然存 `Artifact`，但 Team 的 artifact 不再由客户端直接构造写入。

### 统一后的对象关系

```text
POST /v1/teams
  -> createCanonicalTeamArtifact(...)
  -> db.artifact.create(...)
  -> emit new-artifact event
  -> return team summary + artifact snapshot
```

也就是说：

- **Artifact 继续是存储载体**
- **/v1/teams 是唯一创建入口**
- **clients 不再自己决定 team artifact 的写法**

---

## 决策 C：canonical teamId 默认由客户端先生成，再交给 server 落库

这是本次设计里最关键的迁移选择。

### 方案

`POST /v1/teams` 接收一个可选但对 first-party 客户端“应始终提供”的 `teamId`：

```ts
{
  teamId?: string;
  name: string;
  ...
}
```

### 为什么这样设计

这比“纯 server 生成 ID”更适合当前系统：

1. **兼容现有 CLI 能力**
   - `aha teams create --id <teamId>` 已存在
2. **兼容 Kanban 先拿 teamId 再 spawn 的需求**
   - session tag / env / team route 都会引用 teamId
3. **天然 idempotent**
   - 网络重试时不会额外造出第二个 team
4. **迁移成本最低**
   - 只改 create 入口，不需要重做所有调用顺序

### 约束

- first-party 客户端（Kanban/CLI）应自己先生成 `teamId`
- server 负责校验唯一性
- 若 `teamId` 已存在且属于同一账号，可按 create-idempotent 处理；若属于他人则报冲突

**结论：** teamId 的“生成权”仍可在 client，但“创建权”必须收束到 server。

---

## 决策 D：team 的 canonical 物理格式统一为“server-readable plaintext team artifact”

当前 team artifact 已经事实上分成两种物理格式：

1. client 直写 artifact 的格式
2. `/v1/teams` server 直写的 plaintext compatibility 格式

P0 统一后，应只保留 **server-readable plaintext team artifact** 作为 canonical team 存储格式。

### 目标格式

- `header`: plaintext JSON（base64）
- `body`: `serializeTeamBoard(board)` 的 plaintext JSON（base64）
- `dataEncryptionKey`: `base64('team')`

### 为什么要这样统一

因为 server 必须能：

- 读取 team board
- 修改成员列表
- 读取/写入 team metadata / provenance / workspace snapshot
- 后续支持 template、workspace、policy

而 server **并不掌握客户端 artifact 加密密钥**，因此 team 作为控制面对象，必须采用 server-readable 格式。

**结论：** team artifact 与普通 artifact 不应共享同一种“谁负责加密”的模式。

---

## 4. 新的 `POST /v1/teams` 合同

## 4.1 请求体（建议）

```ts
interface CreateTeamRequest {
  teamId?: string;
  name: string;
  description?: string;

  members?: Array<{
    memberId?: string;
    sessionId: string;
    sessionTag?: string;
    roleId: string;
    displayName?: string;
    specId?: string;
    parentSessionId?: string;
    executionPlane?: string;
    runtimeType?: string;
    lifecycle?: Record<string, unknown>;
  }>;

  seedGoal?: string;

  boardPatch?: Partial<{
    roomId: string;
    metadata: Record<string, unknown>;
    team: {
      roles: unknown[];
      agreements: unknown;
    };
    columns: unknown[];
    tasks: unknown[];
  }>;

  provenance?: {
    source: 'kanban-manual' | 'kanban-prompt' | 'cli' | 'template' | 'promote';
    templateGenomeId?: string;
    roomId?: string;
  };

  // 先作为透传位，供后续 Workspace P0/P1 接入
  workspaceId?: string;
  workspaceSnapshot?: {
    machineId?: string;
    rootPath?: string;
  };
}
```

## 4.2 响应体（建议）

```ts
interface CreateTeamResponse {
  team: {
    id: string;
    name: string;
    memberCount: number;
    taskCount: number;
    members: TeamMemberRecord[];
    createdAt: number;
    updatedAt: number;
  };

  // 给 kanban 直接 hydrate local storage，避免等异步事件
  artifactSnapshot: {
    id: string;
    title: string;
    type: 'team';
    sessions: string[];
    draft: false;
    body: string;
    headerVersion: number;
    bodyVersion: number;
    seq: number;
    createdAt: number;
    updatedAt: number;
    isDecrypted: true;
  };
}
```

### 为什么返回 `artifactSnapshot`

因为当前 Kanban 的 team 列表和 team 页面仍以本地 `artifacts` store 为主。

如果只返回 `team summary`，客户端还得等待异步同步事件，导航存在 race condition。

返回 `artifactSnapshot` 后：

- `kanban` 可立即 `storage.addArtifact(...)`
- 同时 server 仍广播 `new-artifact`
- 最终用事件流做幂等收敛

---

## 5. server 端责任重构

## 5.1 新增单一 service

建议新增一个共享 helper，例如：

- `happy-server/sources/app/team/teamCreation.ts`

对外暴露：

```ts
createCanonicalTeamArtifact(userId, payload)
```

职责：

1. 生成/校验 `teamId`
2. 用 shared default board 构建初始 board
3. 合并 `members` / `seedGoal` / `boardPatch` / `provenance`
4. 序列化为 canonical plaintext team artifact
5. `db.artifact.create(...)`
6. `eventRouter.emitUpdate(new-artifact)`
7. 返回 `team summary + artifactSnapshot`

## 5.2 `POST /v1/teams` 只做参数校验与调用 service

`teamManagementRoutes.ts` 中的 create route 不再自己手写 board，也不再只返回 summary。

## 5.3 使用 shared `DEFAULT_KANBAN_BOARD`

当前 `teamManagementRoutes.ts` 里手写默认列/空 roles/空 agreements，这和 CLI / Kanban 侧默认 board 并不一致。

统一后应使用共享默认 board（来源和 CLI/Kanban 保持一致），避免三端 seed shape 漂移。

---

## 6. 客户端改造方案

## 6.1 Kanban：替换 `createArtifact + registerTeam`

### 当前错误链路

```text
createArtifact(team) -> artifactId
registerTeam(name) -> server teamId
navigate /teams/{artifactId}
```

### 改成

```text
generate teamId locally
POST /v1/teams(teamId, full payload)
<- team + artifactSnapshot
hydrate local artifact store
navigate /teams/{teamId}
```

### `teams/new.tsx` 具体变化

- 删除 `sync.createArtifact(..., 'team')`
- 删除 `sync.registerTeam(...)`
- 改为 `sync.createTeamCanonical(...)` 或扩展现有 `apiTeamManagement.createTeam(...)`
- prompt/manual 模式都先拿 canonical `teamId`
- 后续 spawned members 继续走 `addTeamMember`
- 如果 prompt 创建失败，直接调用 `deleteTeam(teamId)`，而不是 `deleteArtifact(artifactId)`

## 6.2 CLI：`aha teams create` 改走 `/v1/teams`

### 当前

- 直接 `api.createArtifact(...)`

### 统一后

- 构造 `CreateTeamRequest`
- 传 `teamId`（来自 `--id` 或客户端生成）
- `members` 来自 `--sessions`
- `seedGoal` 来自 `--goal`
- 输出 response.team

### CLI 保留兼容

- `--id` 继续保留
- 但它变成 `/v1/teams` 的 `teamId`，不再直接写 artifact

---

## 7. 与后续能力的衔接

这个设计之所以必须先做，是因为下面这些能力都依赖“Team Create 有唯一真源”：

### 7.1 Workspace

未来只要把 `workspaceId` 接到 `POST /v1/teams`：

- Kanban / CLI 不用再各自找地方塞 metadata
- server 可以统一保存 `workspaceId + machine/rootPath snapshot`

### 7.2 Team Template / Corps

未来 `POST /v1/teams/from-template` 不需要重复实现 artifact 写入，只需要：

```text
resolve template -> build CreateTeamRequest -> call createCanonicalTeamArtifact()
```

### 7.3 Agent Promote -> Team

`POST /v1/agents/:id/promote` 不一定会“新建” artifact，但它应该复用同一套 board seed / team normalization helper，避免再造第三种 team shape。

---

## 8. 兼容与迁移策略

## Phase 1 — 引入 canonical route（兼容期）

- 扩展 `POST /v1/teams`
- 返回 `artifactSnapshot`
- 发 `new-artifact` update
- Kanban / CLI 新增新调用路径
- 保留现有 `POST /v1/artifacts` 对 team 的创建能力，但打 debug warning

## Phase 2 — 切换 first-party 客户端

- `kanban/sources/app/(app)/teams/new.tsx` 切到 `/v1/teams`
- `aha-cli/src/commands/teams.ts` 切到 `/v1/teams`
- 删除 `sync.registerTeam()` 调用

## Phase 3 — 收紧低层入口

- `POST /v1/artifacts` 对 `type='team'` / `type='standalone'` 的 first-party create 直接拒绝
- 报错信息明确提示：
  - team 请用 `/v1/teams`
  - standalone agent 请用 `/v1/agents`

## Phase 4 — 清理旁路代码

- 删除 Kanban 的 team create 双写逻辑
- 删除 CLI 中 team create 的 direct artifact path
- 给 docs/测试统一到 canonical path

---

## 9. 风险与注意点

### 风险 1：Kanban 仍依赖本地 artifact store

**处理：** response 返回 `artifactSnapshot` + server 发 `new-artifact` event，双保险。

### 风险 2：已有 team 的存储格式不一致

**处理：** 读路径继续兼容；只统一“新创建”的写路径，不强制迁移历史 team。

### 风险 3：session metadata 不是 server 可写真源

当前 session metadata 是加密的，server 不掌握密钥，因此：

- `teamId/role` 写入 session metadata 仍然只能由客户端 best-effort 完成
- **canonical truth 仍然应定义在 team artifact / team routes 上**
- 不要再把 session metadata 当成 team create 的真源

### 风险 4：创建后再 spawn 的流程顺序变化

**处理：** first-party 客户端统一先生成 `teamId`，再调 `/v1/teams`，然后 spawn，顺序是稳定的。

---

## 10. 最小实施面（建议文件）

### `happy-server`

- `sources/app/api/routes/teamManagementRoutes.ts`
- `sources/app/team/teamCreation.ts`（新）
- `sources/app/team/teamArtifacts.ts`
- `sources/app/api/routes/artifactsRoutes.ts`

### `kanban`

- `sources/sync/apiTeamManagement.ts`
- `sources/sync/sync.ts`
- `sources/app/(app)/teams/new.tsx`

### `aha-cli`

- `src/api/api.ts`
- `src/commands/teams.ts`

---

## 11. 验收标准

完成后应满足：

1. Kanban 创建 team 时，不再调用 `createArtifact(..., 'team')`
2. Kanban 创建 team 时，不再调用 `registerTeam()`
3. CLI `aha teams create` 不再直接写 artifact
4. 一次创建只出现一个 canonical teamId
5. `/v1/teams` 返回的 `team.id` 与本地导航 `/teams/:id` 完全一致
6. 其他已登录客户端可通过 `new-artifact` 事件看到新 team
7. 后续给 `POST /v1/teams` 增加 `workspaceId` 时，无需再次改 team create 架构

---

## 12. 结论

这次 P0 不是“把 team 从 artifact 改成别的对象”，而是：

- **保留 Artifact 作为存储载体**
- **把 Team Create 的写入口收束到 `/v1/teams`**
- **把 ID、board seed、artifact envelope、event broadcast 都集中到 server**

一句话总结：

> Team 仍然存成 artifact，但以后只能通过 Team 控制面创建，不能再由各个客户端各写各的。

这是后续接入 `workspaceId`、template instantiate、standalone promote、team policy 的前置条件。
