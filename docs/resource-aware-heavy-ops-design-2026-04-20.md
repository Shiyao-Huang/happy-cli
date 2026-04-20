# 资源感知与重操作编译锁设计（#P-001）

日期：2026-04-20  
作者：architect  
范围：`aha-cli-0330-max-redefine-login`

---

## 1. 问题定义

当前团队在执行以下重操作前，模型缺少统一的资源意识：

- `yarn build` / `pkgroll`
- 全量 `tsc --noEmit`
- 全量 `vitest run`
- 其他高内存 Node 编译/打包任务

结果是 3-5 个 agent 可能同时启动重操作，累计占用 12GB+ 内存，把整机拖死。

这不是单个命令太重的问题，而是系统里缺少三层能力：

1. **资源状态可见性**：agent 在执行前看不到机器负载与现有重任务数  
2. **统一准入控制**：没有“现在能不能跑”的中心裁决  
3. **显式协作协议**：没有统一的 heavy-op slot / lease 模型

---

## 2. 现状审计

仓库里已经有一些“半成品能力”，但它们是分散的：

### 2.1 `src/daemon/hostHealth.ts`

已经实现了纯同步的主机健康快照：

- free/total memory
- disk free
- load average
- active agent count
- alerts 生成

但目前没有真正暴露成通用 agent 工具；文件注释提到 `get_host_health MCP tool`，代码里却没有完整注册入口。

### 2.2 `src/claude/mcp/supervisorTools.ts` 的 `tsc_check`

`tsc_check` 已经具备两项关键能力：

- **内存 pre-check**
- **独占 file lock**

这说明系统已经承认“类型检查是高风险重操作”，但这个保护只覆盖一个专用工具，没有覆盖：

- `build`
- `pkgroll`
- 全量 `vitest`
- 任意 shell 编译命令

### 2.3 `src/daemon/sessionManager.ts`

daemon 已根据系统总内存自动计算 Claude agent 并发上限：

- 预留系统内存
- 用经验值估算每个 agent 的占用
- 限制 spawn 并发

这说明“资源预算”思想已经存在，但目前只用于**agent 进程数**，还没有用于**重操作本身**。

---

## 3. 设计目标

### 3.1 目标

1. agent 在运行重操作前，能读取当前资源状态  
2. 系统能拒绝或排队过量的重操作  
3. 同一时间只允许有限数量的 heavy-op 运行  
4. 规则要同时适用于 Claude/Codex runtime  
5. 优先复用现有 `hostHealth`、`tsc_check`、daemon lock 机制

### 3.2 非目标

1. 不在第一阶段实现精确的进程级 CPU/内存归因  
2. 不在第一阶段拦截所有 shell 命令  
3. 不要求一次性解决所有 repo 的 build 行为差异

---

## 4. 核心方案

## 4.1 新增统一组件：`ResourceGovernor`

建议新增：

- `src/daemon/resourceGovernor.ts`

职责：

1. 采样主机资源（复用 `getHostHealth()`）
2. 维护 heavy-op lease / lock
3. 根据策略判断一个重操作是否允许启动
4. 提供当前资源快照和阻塞原因

建议模型：

```ts
type HeavyOpKind =
  | 'build'
  | 'typecheck'
  | 'full-test'
  | 'package'
  | 'custom-heavy';

type HeavyOpClass = 'exclusive' | 'heavy' | 'medium';

interface HeavyOpLease {
  id: string;
  kind: HeavyOpKind;
  opClass: HeavyOpClass;
  sessionId?: string;
  role?: string;
  repoPath?: string;
  startedAt: number;
  expiresAt: number;
  command?: string;
}
```

资源治理结果：

```ts
interface ResourceAdmissionDecision {
  allowed: boolean;
  reason?: string;
  host: HostHealthReport;
  activeLeases: HeavyOpLease[];
  recommendedWaitSeconds?: number;
}
```

---

## 4.2 统一分级：把重操作分类

建议第一版策略：

### `exclusive`

同一时间最多 1 个：

- `yarn build`
- `pkgroll`
- 全量 `vitest run`
- 其他已知会吃掉 8GB+ 的命令

### `heavy`

可配置，默认最多 1 个：

- 全量 `tsc --noEmit`
- `tsc_check`
- `prisma generate`
- 大型 bundle / compile

### `medium`

允许 1-2 个，取决于剩余内存：

- 单仓库 targeted build
- 单文件 Vitest
- 较小范围类型检查

---

## 4.3 暴露给 agent 的两个核心工具

### 工具 1：`get_resource_status`

建议新增通用 MCP tool，所有角色可见。

返回：

- freeMem / freeMemPct
- load average
- 当前 active heavy-op leases
- 当前策略限制
- 建议：现在可否运行 build / tsc / test

示例输出：

```text
Memory: 3.2 GB free (11%)
Load: 7.8 / 6.9
Heavy ops running: 1
- build by session xyz (repo: aha-cli)

Recommendation:
- build: denied
- typecheck: denied
- targeted vitest: allowed
```

### 工具 2：`acquire_heavy_op_slot`

参数：

- `kind`
- `repoPath`
- `command`
- `estimatedMemoryMb?`
- `ttlSeconds?`

行为：

- 若系统允许，则创建 lease 并返回 permit
- 若不允许，则返回明确拒绝原因

配套工具：

- `release_heavy_op_slot`

说明：为了可靠释放，也可以在第一版直接把它设计成 `withHeavyOpLease()` 包装器，由工具内部自动 acquire/release。

---

## 4.4 先复用，后统一：把 `tsc_check` 接到 `ResourceGovernor`

当前 `tsc_check` 已经有：

- 内存阈值
- 文件锁

第一阶段建议不要重写逻辑，而是：

1. 把 `tsc_check` 的内存判断迁移到 `ResourceGovernor`
2. 把 `tsc.lock` 替换成 governor lease
3. 保持原用户体验不变

这样能最小代价把现有经验固化为统一基线。

---

## 4.5 Prompt / 基因组层：让 agent “先看，再跑”

平台层仅做工具还不够，agent 需要在行为层被明确约束。

建议修改：

- `src/claude/team/alwaysInjectedPolicies.ts`
- `src/utils/agentLaunchContext.ts`

加入统一规则：

1. 在执行 heavy-op 前，必须先调用 `get_resource_status`
2. 若 heavy-op 属于受控类别，必须先 acquire slot
3. 若资源紧张或 slot 被占用，必须等待或协调，不得直接执行

建议新增文案：

> Before any high-memory operation (full build, full typecheck, full test), call `get_resource_status` first.  
> If the operation is classified as heavy, you must acquire a heavy-op slot before running it.

---

## 4.6 Runtime 层增强：把风险前移到 UI / 事件流

建议后续在：

- `src/codex/runCodex.ts`
- `src/claude/runClaude.ts`

增加轻量增强：

1. session 启动时展示当前 host health 摘要  
2. 当 runtime 观察到 `exec_command_begin` 是已知 heavy-op 且没有 lease 时：
   - 先发 warning
   - 记录 trace
   - 第二阶段可升级为阻止执行

这是第二阶段能力，因为任意 shell 命令的完全拦截需要更谨慎。

---

## 5. 推荐落地顺序

## Phase 1：先止血（最小闭环）

目标：让 agent 能看见资源，并让重操作有统一锁

改动：

1. 新增 `resourceGovernor.ts`
2. 注册 `get_resource_status`
3. 注册 `acquire_heavy_op_slot` / `release_heavy_op_slot`
4. `tsc_check` 接入 governor
5. 更新 prompt/launch context 文案

产出效果：

- agent 可以先看资源
- `tsc_check` 不再各自为战
- 团队层有了统一 slot

## Phase 2：扩展到更多命令

1. build / pkgroll / full vitest 走统一 governor
2. 将高风险操作列入 command classifier
3. 在 Codex/Claude runtime 中增加“无 lease 的 heavy-op 告警”

## Phase 3：团队级治理

1. supervisor 检测 lease 冲突并预警
2. team chat 自动广播：
   - 谁拿到了 heavy-op slot
   - 哪个 slot 已释放
3. 把资源状态纳入 `get_self_view` / team overview

---

## 6. 建议修改文件

### 新增

- `src/daemon/resourceGovernor.ts`
- `src/daemon/resourceGovernor.test.ts`
- `src/claude/mcp/resourceTools.ts`

### 修改

- `src/daemon/hostHealth.ts`
- `src/claude/mcp/index.ts`
- `src/claude/mcp/supervisorTools.ts`
- `src/claude/team/alwaysInjectedPolicies.ts`
- `src/utils/agentLaunchContext.ts`
- `src/codex/runCodex.ts`
- `src/claude/runClaude.ts`

---

## 7. 为什么这个方案适合当前代码库

因为当前仓库已经具备三个关键基础件：

1. `hostHealth`：已有资源快照能力  
2. `tsc_check`：已有高内存命令专用防护  
3. `sessionManager`：已有基于内存的并发预算思路

所以 P-001 不需要从零开始，只需要把这些分散能力收敛成统一治理层。

---

## 8. 一句话结论

**P-001 的正确修法不是给每个 agent 再加一句“注意内存”，而是把已有的 host health、tool guard、daemon lock 收敛成统一的 `ResourceGovernor`，再通过 `get_resource_status + heavy-op lease` 把资源意识真正注入执行链路。**
