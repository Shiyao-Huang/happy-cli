# Sprint 2026-03-18 Team Deliverables

> **隔离记录**：本文档记录通过 Aha Team 多 agent 协作完成的变更。
> 影响范围待评估，独立于主干文档存档。

---

## 变更总览

| 模块 | 文件 | 类型 | Owner |
|------|------|------|-------|
| 模型常量工具 | `src/utils/modelContextWindows.ts` | 新增 | cmmvx2l8 |
| 模型常量测试 | `src/utils/modelContextWindows.test.ts` | 新增 | cmmvx2l8 |
| Agent 运行时入口 | `src/claude/runClaude.ts` | 修改 | cmmvx0n2 + cmmvx2l8 |
| Sessions CLI | `src/commands/sessions.ts` | 新增 | cmmvx2kn |
| Agents CLI | `src/commands/agents.ts` | 修改 | cmmvx0n2 |
| API 类型定义 | `src/api/types.ts` | 修改 | cmmvx0n2 |
| MCP Server | `src/claude/utils/startAhaServer.ts` | 修改 | cmmvx0n2 + cmmvx0ng |
| Materializer | `src/agentDocker/materializer.ts` | 修改 | cmmvx2kn |
| CLI 入口 | `src/index.ts` | 修改 | cmmvx2kn |
| Agent 操作指南 | `docs/aha-v3-agent-guide.md` | 新增/修改 | cmmvx0ng |
| CLI 参考文档 | `docs/aha-v3-cli-reference.md` | 新增 | cmmvx0ng |
| Skill 快速参考 | `skills/aha-v3-reference/SKILL.md` | 新增 | cmmvx0ng |

---

## 各文件变更详情

### 1. `src/utils/modelContextWindows.ts` （新增）

**内容：**
- `DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS = 200_000`
- `MODEL_CONTEXT_WINDOWS`：11 个 claude-4.x 型号的 context window 常量映射
- `resolveContextWindowTokens(modelId?)`：三级匹配（exact → prefix → claude-* 默认）
- `buildModelSelfAwarenessPrompt(opts)`：生成"## Runtime Model Identity"系统提示块

**影响范围：** 纯工具模块，无副作用，被 `runClaude.ts` 和 `sessions.ts` import。

---

### 2. `src/utils/modelContextWindows.test.ts` （新增）

**内容：** 覆盖 `resolveContextWindowTokens` 和 `buildModelSelfAwarenessPrompt` 的单元测试，3 tests pass。

---

### 3. `src/claude/runClaude.ts` （修改）

**变更点一：** import 新增
```typescript
import { buildModelSelfAwarenessPrompt, resolveContextWindowTokens } from '@/utils/modelContextWindows';
```

**变更点二：** line ~295，去掉 `as any` 强转
```typescript
// 修改前：
const sessionModelOverride = (session.getMetadata() as any)?.modelOverride as string | undefined;
// 修改后：
const sessionModelOverride = session.getMetadata()?.modelOverride;
```

**变更点三：** 新增 `syncModelAwareness()` 函数（line ~329）

每次调用：
1. 计算 `contextWindowTokens = resolveContextWindowTokens(currentModel)`
2. 生成 `currentModelAwarenessPrompt`（注入 append system prompt 链）
3. 写入 session metadata：`contextWindowTokens`、`resolvedModel`

调用时机：
- 启动时调用一次（model 解析完成后，line ~515）
- 每次 user message 时调用（line ~1298），支持动态刷新

**影响范围：** 影响所有通过 `runClaude.ts` 启动的 agent session。每个 agent 的 system prompt 会追加一个"Runtime Model Identity"块；session metadata 会实时写入 `contextWindowTokens` 和 `resolvedModel` 字段。

---

### 4. `src/commands/sessions.ts` （新增）

**内容：** 完整的 `aha sessions` CLI 子命令实现。

子命令：
- `list [--active] [--team <id>] [--json]`
- `show <sessionId> [--verbose] [--json]`
- `archive <sessionId> [--force]`
- `delete <sessionId> [--force]`

`show` 输出包含（`--verbose` 模式）：
- `resolvedModel`（从 session metadata 读取，由 `runClaude.ts` 实时写入）
- `contextWindowTokens`（同上，或由 `resolveContextWindowTokens` 推导）

**影响范围：** 新增命令，不影响现有功能。

---

### 5. `src/commands/agents.ts` （修改）

**变更：** `AgentUpdateOptions` 新增 `model` / `fallbackModel` 字段，`--model` / `--fallback-model` CLI 标志。

执行时写入 session metadata：
```typescript
nextMetadata.modelOverride = updates.model;
nextMetadata.fallbackModelOverride = updates.fallbackModel;
```

**影响范围：** 仅扩展已有 `agents update` 命令，不破坏现有标志。`modelOverride` 在 agent 下次重启时生效。

---

### 6. `src/api/types.ts` （修改）

**变更：** `Metadata` 类型新增两个可选字段：
```typescript
modelOverride?: string,
fallbackModelOverride?: string,
```

**影响范围：** 类型定义变更，删除了 `runClaude.ts` 中的 `as any` 强转。二进制兼容，不影响现有序列化/反序列化。

---

### 7. `src/claude/utils/startAhaServer.ts` （修改）

**变更一：** `list_team_agents` handler（line ~1657）

修复 `executionPlane` / `runtimeType` 为 null 的展示 bug：
```typescript
const BYPASS_ROLE_IDS = ['supervisor', 'help-agent'];
executionPlane: member?.executionPlane ||
    (BYPASS_ROLE_IDS.includes(roleId) ? 'bypass' : 'mainline'),
runtimeType: member?.runtimeType || 'claude',
```

> ⚠️ 注意：这是展示层 fallback，不修改持久化数据。老 session 的 metadata 中 `executionPlane` 仍为 null，仅在 API 响应时补默认值。

**变更二：** 新增 `update_agent_model` MCP tool

权限：仅 `supervisor` / `master` 角色可调用。

行为：写入目标 session 的 `metadata.modelOverride` / `fallbackModelOverride`，下次重启生效。

**影响范围：** 影响所有调用 `list_team_agents` 的客户端（展示修正）；新增 MCP tool 不影响现有工具。

---

### 8. `src/agentDocker/materializer.ts` （修改）

**新增类型：** `RuntimeLibResourceType`、`MaterializationMode`

**新增函数：**
- `getRuntimeLibLayout()`：返回 runtime-lib 目录结构定义
- `ensureRuntimeLibStructure()`：创建 `runtime-lib/{skills,mcp,prompts,hooks,tools}` 目录
- `resolveMaterializationPolicy(mode)`：按模式返回 symlink 或 copy 策略
- `linkSharedResource()` / `copyPrivateResource()`：资源物化执行
- `.genome/` overlay 写入：`spec.json`、`lineage.json`、`eval-criteria.md`
- `__genome_ref__` contextInjections 注入
- `buildAgentWorkspacePlanFromGenome()` 透明传递 `specId`

**影响范围：** 影响所有通过 materializer 创建工作区的流程（`aha agents spawn` 等）。新增文件写入到 agent workspace，不影响已有 workspace 的读取逻辑。

---

### 9. `src/index.ts` （修改）

**变更：** 注册 `sessions` / `session` 命令（双别名）。

**影响范围：** 新增入口，不影响现有命令路由。

---

## 已修正的 Bug

| Bug | 位置 | 修正方式 |
|-----|------|---------|
| `org-manager` 被错误标为 bypass role | `docs/aha-v3-agent-guide.md` + 代码注释 | 文档修正，代码中 `BYPASS_ROLE_IDS` 从未包含 org-manager |
| `update_agent_model` 工具描述错误（"next tool call"） | `startAhaServer.ts` | 修正为"next time the agent session is started/restarted" |
| `update_agent_model` 权限过宽（含 solution-architect） | `startAhaServer.ts` | 移除 solution-architect，仅保留 supervisor/master |
| `resolvedModel` 从未写入 metadata | `runClaude.ts:syncModelAwareness()` | 在 `updateMetadata` 块内补写 `nextMetadata.resolvedModel = currentModel` |

---

## 未触及的内容

以下内容**未被本次 sprint 修改**：

- 现有 `aha agents list/show/update/archive/delete` 逻辑（除 `--model` 标志扩展外）
- 认证/权限系统
- 任何现有 MCP tools（除新增 `update_agent_model`）
- 数据库 schema / session 持久化格式
- Docker 相关代码（仅新增测试 fixture，不修改生产代码）
- Genome hub / genome registry 逻辑

---

## P2 延期事项（本轮未实现）

| 功能 | 说明 |
|------|------|
| `search_genomes` MCP tool | 架构规格已完成，实现延期 |
| score-gated version promotion | `experimental → active → deprecated` 晋级逻辑 |
| `evolve_genome` pipeline | supervisor 发起 mutation → 生成新 spec |
| skill digest tracking | `pinnedDigest` + `updatePolicy` 字段 |
| `aha genomes fork/publish` CLI | P2 实现 |
| git worktree isolated workspace | materializer `isolated` 模式的完整实现 |
