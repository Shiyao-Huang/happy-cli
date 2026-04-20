# Sprint 2026-03-18 Delivery Record

> **隔离记录**：本文档单独记录 2026-03-18 通过 multi-agent team 完成的交付。
> 这些变更尚未经过完整的端到端验证，影响范围有待评估。
> 主线文档（aha-v3-agent-guide.md、aha-v3-cli-reference.md）已同步更新。

---

## 变更文件索引

| 文件 | 类型 | 变更性质 |
|------|------|---------|
| `src/commands/sessions.ts` | 新命令 | 全新实现 |
| `src/commands/agents.ts` | 命令扩展 | 新增 spawn + model flags |
| `src/claude/utils/startAhaServer.ts` | Bug fix + 新 MCP tool | BYPASS 修正 + update_agent_model |
| `src/agentDocker/materializer.ts` | 功能扩展 | runtime-lib + .genome overlay |
| `src/claude/runClaude.ts` | 功能扩展 | 模型自知注入 + AHA_SETTINGS_PATH |
| `src/utils/modelContextWindows.ts` | 新文件 | 上下文窗口映射模块 |
| `src/api/types.ts` | 类型扩展 | modelOverride / fallbackModelOverride |
| `src/index.ts` | 路由注册 | 注册 sessions / session 命令 |
| `docs/aha-v3-agent-guide.md` | 文档修正 | BYPASS 角色分类纠正 |
| `docs/aha-v3-cli-reference.md` | 文档更新 | 新命令参考 |

---

## 1. Bug Fix：BYPASS_ROLE_IDS 修正

**文件**：`src/claude/utils/startAhaServer.ts` ~line 1657

**问题**：`org-manager` 被错误标记为 bypass 执行平面。

**修正前**：
```typescript
executionPlane: member?.executionPlane || 'mainline'
```

**修正后**：
```typescript
const BYPASS_ROLE_IDS = ['supervisor', 'help-agent'];
executionPlane: member?.executionPlane ||
    (BYPASS_ROLE_IDS.includes(roleId) ? 'bypass' : 'mainline'),
runtimeType: member?.runtimeType || 'claude',
```

**影响评估**：
- `supervisor` / `help-agent` 行为不变（仍是 bypass）
- `org-manager` 将从 bypass 变为 mainline（如有生产环境的 org-manager agent 需关注）
- `master` / `orchestrator` / `builder` / `qa` 不受影响

---

## 2. 新命令：`aha sessions`

**文件**：`src/commands/sessions.ts`（全新），`src/index.ts`（注册）

**新增子命令**：

```bash
aha sessions list [--active] [--team <teamId>] [--json] [--verbose]
aha sessions show <sessionId> [--json] [--verbose]
aha sessions archive <sessionId> [--force]
aha sessions delete <sessionId> [--force]
```

**`aha sessions show` 额外输出字段**（需 agent 已启动并更新过 metadata）：
```
resolvedModel=claude-sonnet-4-6
contextWindowTokens=200000
```

**影响评估**：
- 纯新增命令，不修改现有 API 行为
- `archive` / `delete` 有确认提示，`--force` 跳过（与 agents 命令一致）
- `resolvedModel` 字段在 agent 首次 user message 后才有值（启动阶段为空）

---

## 3. 命令扩展：`aha agents spawn` + 模型 flags

**文件**：`src/commands/agents.ts`

### 3a. `aha agents spawn <file.agent.json>`

```bash
aha agents spawn examples/builder.agent.json \
  --team <teamId> \
  --role builder \
  --path /repo/path
```

流程：
1. 读取 + 校验 `agent.json`（schema: agent-json-v1）
2. 调用 `materializeAgentWorkspace()` 生成本地工作区
3. 通过 daemon `/spawn-session` 启动 Claude Code 进程
4. 注入 `AHA_SETTINGS_PATH` 指向物化后的 `settings.json`
5. 自动注册 team roster

**影响评估**：
- 依赖 `materializeAgentWorkspace()` 的新实现（见第 5 节）
- `AHA_SETTINGS_PATH` 绕过 genome lookup——意味着 genome spec 不生效（设计如此）
- daemon `/spawn-session` 端点须已实现（后端依赖）

### 3b. `aha agents update --model / --fallback-model`

```bash
aha agents update <sessionId> \
  --model claude-opus-4-5 \
  --fallback-model claude-sonnet-4-5
```

写入 `metadata.modelOverride` / `metadata.fallbackModelOverride`。

**影响评估**：
- 写入即时，但 agent 需重启后才读取新值（`syncModelAwareness()` 在 startup 读一次）
- 不影响当前运行中 session 的行为

---

## 4. 新 MCP Tool：`update_agent_model`

**文件**：`src/claude/utils/startAhaServer.ts` ~line 1688

**权限**：仅 `supervisor` / `master` 角色可调用（其他角色调用返回权限错误）

**签名**：
```
update_agent_model(sessionId: string, modelId: string, fallbackModelId?: string)
```

**行为**：写入目标 session 的 `metadata.modelOverride`（+ 可选 `fallbackModelOverride`）。

**影响评估**：
- 不影响运行中 session 行为（需重启生效）
- 权限检查基于调用方 session 的 metadata.role——如 metadata 被篡改存在绕过风险

---

## 5. materializer 扩展：runtime-lib + .genome overlay

**文件**：`src/agentDocker/materializer.ts`

### 5a. Runtime-lib 结构

新增类型和函数：

```typescript
type RuntimeLibResourceType = 'skills' | 'mcp' | 'prompts' | 'hooks' | 'tools';
type MaterializationMode = 'link' | 'copy';

getRuntimeLibLayout(runtimeLibRoot: string): RuntimeLibLayout
ensureRuntimeLibStructure(runtimeLibRoot: string): RuntimeLibLayout
resolveMaterializationPolicy(config, resourceType, skillName?): MaterializationMode
linkSharedResource(sourcePath: string, targetPath: string): void
copyPrivateResource(sourcePath: string, targetPath: string): void
```

`link` 模式：symlink 到共享只读资源（节省磁盘）
`copy` 模式：私有副本（支持 agent 级别修改）

### 5b. `.genome/` workspace overlay

当 genome spec 可用时，`materializeAgentWorkspace()` 在工作区写入：

| 文件 | 内容 |
|------|------|
| `.genome/spec.json` | GenomeSpec 快照（当前版本） |
| `.genome/lineage.json` | `{ parentId, mutationNote, origin }` |
| `.genome/eval-criteria.md` | 从 genome spec 提取的验收标准 |

同时注入 `__genome_ref__` contextInjections（含 `specId` + `version`）。

**影响评估**：
- `.genome/` 写入在每次 `materializeAgentWorkspace()` 时发生——如 genome spec 频繁变更，可能产生陈旧文件
- `linkSharedResource` 依赖 `fs.symlink`——Windows 环境需管理员权限（已知限制）
- 测试：materializer 测试 26 passed / 5 skipped（5 个跳过需真实 Docker daemon）

---

## 6. 新模块：`src/utils/modelContextWindows.ts`

**全新文件**，包含：

```typescript
const MODEL_CONTEXT_WINDOWS: Record<string, number>
// 11 个 claude-4.x 型号 → 200_000（当前产品线全部 200K）

resolveContextWindowTokens(modelId?: string): number | undefined
// 三级降级：exact match → prefix match → 'claude-' prefix default

buildModelSelfAwarenessPrompt(model, fallback?, contextTokens?): string
// 生成"## Runtime Model Identity"系统提示块
```

**影响评估**：
- 映射表硬编码——新模型上线需手动更新
- `claude-` prefix fallback 默认返回 200_000——对非 claude 模型（如 codex）不适用
- 3 个单元测试通过

---

## 7. runClaude.ts：模型自知注入

**文件**：`src/claude/runClaude.ts`

新增 `syncModelAwareness()` 调用位置：
1. **startup**（line ~515）：agent 启动时注入一次
2. **每次 user message**（line ~1298）：动态刷新（支持 message-level model override）

metadata 写入：
```typescript
nextMetadata.contextWindowTokens = contextWindowTokens;
nextMetadata.resolvedModel = currentModel || undefined;
```

`AHA_SETTINGS_PATH` 支持（line ~430）：
```typescript
const _prebuiltSettingsPath = (!_genomeSpec && process.env.AHA_SETTINGS_PATH)
    ? process.env.AHA_SETTINGS_PATH : undefined;
```

**影响评估**：
- `resolvedModel` 在首次 user message 后才写入 metadata（`aha sessions list` 不显示，`aha sessions show` 显示）
- per-message 注入会略微增加每次请求的 token 用量（awareness block ~50 tokens）
- `AHA_SETTINGS_PATH` 与 genome spec 互斥（有 genome spec 时 PATH 不生效）

---

## 8. types.ts：新增类型字段

**文件**：`src/api/types.ts` ~line 439

```typescript
interface Metadata {
  // ...existing fields
  modelOverride?: string;
  fallbackModelOverride?: string;
  resolvedModel?: string;
  contextWindowTokens?: number;
}
```

**影响评估**：
- 纯类型扩展，optional 字段，向后兼容
- 旧 session metadata 不含这些字段——读取时返回 `undefined`（正常）

---

## 测试状态

| 范围 | 结果 |
|------|------|
| `modelContextWindows.test.ts` | 3 passed |
| `materializer.test.ts` | 26 passed / 5 skipped（需 Docker） |
| `yarn build` | ✅ ~6s |
| E2E / integration | 未覆盖（P2） |

---

## P2 遗留（本轮未实现）

以下功能架构规格已完成（`docs/launch-genome-architecture-2026-03-18.md`），实现延后：

| 功能 | 复杂度 | 文件 |
|------|--------|------|
| `search_genomes` MCP tool | LOW | startAhaServer.ts ~1340 |
| `aha genomes publish` 验证 | LOW | — |
| Skill digest tracking | MEDIUM | fetchGenome.ts + GenomeSpec type |
| `aha genomes fork` CLI | MEDIUM | — |
| `aha config model-routes` CLI | MEDIUM | — |
| `aha proxy start/stop/status` | MEDIUM | — |
| Score-gated genome versioning | HIGH | VersionPromotionPolicy |
| `evolve_genome` MCP pipeline | HIGH | — |
