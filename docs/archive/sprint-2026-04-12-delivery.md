# Sprint 2026-04-12 Delivery Record

> **隔离记录**: 2026-04-12 multi-agent team 完成的交付。
> 核心主题：Mom Test 访谈 → 基因组进化闭环验证 + P0 可见性修复 + 高并发能力。

---

## 1. P0 Genome Visibility Incident

### 事故描述

0412 Mom Test 进化闭环完成后，所有 `@official/*` 最新版本虽然写入了 genome-hub，但 `list_available_agents` 和默认 `create_agent` 路径只能看到旧的 public 版本。

### 数据证据

| Genome | Latest (private) | Search returned | Gap |
|--------|-----------------|-----------------|-----|
| implementer | v36 | v18 | 18 versions invisible |
| master | v33 | v18 | 15 versions |
| supervisor | v28 | v9 | 19 versions |
| reviewer | v36 | v12 | 24 versions |
| org-manager | v8 | v3 | 5 versions |

### 根因链（精确）

1. **Two-table architecture**: genome-hub 有 `Genome` 表（旧 `/genomes/*` 路由）和 `Entity` 表（新 `/entities/*` 路由）
2. **Search 过滤**: `/genomes` search 添加 `e."isPublic" = true`，只返回 public 版本
3. **Entity diff 继承**: `entityStore.ts#applyEntityDiff()` 创建新版本时写 `isPublic: txLatest.isPublic` — 继承父版本可见性
4. **源头**: 某个早期版本被创建为 `isPublic=false`，后续所有 diff-based evolution 都继承了 private
5. **Spawn 路径**: `resolvePreferredAgentImageId()` 默认 `strategy='best-rated'`，先走 marketplace search（public only），只有找不到时才 fallback 到 `resolveOfficialGenomeSpecId()`（latest-by-name，无 isPublic 过滤）

**注意**: 另一个 help-agent 提出 `evolutionTools.ts:202` 的 `z.boolean().default(false)` 是根因，但 implementer 纠正：该行属于 `create_genome` tool，不是 `evolve_genome`。真正的 evolution 路径是 `supervisorTools.ts` → `submitDiffViaMarketplace()` → `POST /entities/:ns/:name/diffs` → `applyEntityDiff()`。

### 修复措施

**即时缓解 (Fix A)**: 通过 genome-hub API 把所有 `@official/*` 最新版本 promote 为 `isPublic=true`。验证后 search 返回正确版本。

**待落地 hardening**:
- **Fix B**: `resolvePreferredAgentImageId()` 对 `@official` namespace 优先走 `resolveOfficialGenomeSpecId()`（latest-by-name），marketplace search 降为 fallback。已有 helper，只需调换优先级。
- **Fix C**: 明确 `create_genome` / promotion 对 `@official` 的默认 public policy，防止未来再次从 private 源头开始继承链。

### 教训

- Spawn 语义和 public discoverability 应该分离
- `isPublic` 继承链是正确的（evolution 不应改变 visibility without intent），但需要初始 creation 的 policy 保障
- Evolution 后应验证 marketplace 可见性，而不是假设写入 = 可见

---

## 2. Marketplace Multi-Word Query Fix

### 问题

`searchMarketplaceGenomes({ query: 'implementer builder' })` 传给 genome-hub 作为单个 query string，hub 做精确匹配返回 0 结果。

### 修复

**Client-side** (`genomeMarketplace.ts`):
- 新增 `tokenizeMarketplaceQuery()` 按 word boundary 拆分 query
- `searchMarketplaceGenomes()` 先用完整 query 搜索
- 如果返回 0 结果且 tokens >= 2，并行 `Promise.all` 对每个 token 单独搜索，合并去重

**Server-side** (genome-hub `genomeSearch.ts`, 已 commit 518fa89):
- 搜索逻辑支持 multi-term 查询

### 文件变更

- `src/utils/genomeMarketplace.ts` — 新增 `tokenizeMarketplaceQuery()`, `fetchMarketplaceGenomePage()`, fallback 逻辑
- `src/utils/genomeMarketplace.test.ts` — 对应测试

---

## 3. Batch Spawn + Resource-Adaptive Concurrency

### batch_spawn_agents MCP Tool

新 MCP tool，支持一次 tool call 并行 spawn 最多 10 个 agent。

**关键设计**:
- `Promise.all` 并行 dispatch 到 daemon spawn queue
- 每个 agent 独立 `createTeamMemberIdentity()`（memberId + sessionTag）
- `resolvePreferredAgentImageId()` 解析 genome
- 成功 spawn 后 register 到 team roster
- 最后调用 `publishTeamCorpsTemplate()` 一次
- 返回结构化结果：`{ success, role, sessionId, memberId, specId, specSource, status }`

**文件**: `src/claude/mcp/agentTools.ts` (新增 ~196 行)

### Resource-Adaptive Concurrency

**旧行为**: `getMaxConcurrentClaude()` 无 `AHA_MAX_CONCURRENT_CLAUDE_AGENTS` 环境变量时返回 `Infinity`。

**新行为**: Auto-detect from system memory:
```
totalMemGB = os.totalmem() / GB
available = max(totalMem - 4GB, 1GB)
autoLimit = floor(available / 0.5GB)  // 每个 agent ~300-500MB
result = clamp(autoLimit, min=3, max=20)
```

**文件**: `src/daemon/sessionManager.ts` (`getMaxConcurrentClaude()`)

### 其他变更

- `create_agent` tool: limit 提示从 4 改为 10，新增 batch_spawn 建议
- `list_available_agents`: 移除 `canSpawnAgents` gate（browse 是只读 marketplace，spawn gating 只在 create_agent）

---

## 4. Mom Test Sprint 0412

3 个 agent 完成基于 Mom Test 方法论的深度访谈（具体 past behavior 问题，3 轮迭代收敛）。

基于访谈发现，6 个 @official genome 完成进化：
- implementer → v36
- master → v33
- supervisor → v28
- reviewer → v36
- researcher → v22
- help-agent → v5

进化后触发了 P0 可见性事故（见第 1 节），已修复。

---

## 变更文件索引

| 文件 | 变更性质 | 状态 |
|------|---------|------|
| `src/claude/mcp/agentTools.ts` | batch_spawn_agents + RBAC + limit bump | 已 commit `27c4e4f` |
| `src/daemon/sessionManager.ts` | resource-adaptive concurrency | 已 commit `27c4e4f` |
| `src/utils/genomeMarketplace.ts` | multi-word query fallback | 已 commit `27c4e4f` |
| `src/utils/genomeMarketplace.test.ts` | marketplace fallback tests | 已 commit `27c4e4f` |
| genome-hub `genomeSearch.ts` | server-side multi-word search | 已 commit `518fa89` |
| genome-hub `genomeStore.ts` | @official force isPublic during diff | 已 commit `adedf1b` |

---

## 待用户决策

1. **Fix B (resolvePreferredAgentImageId 优先级)**: 对 @official 走 latest-by-name，marketplace 降为 fallback。低风险，已有 helper。
2. **Fix C (evolve isPublic policy)**: @official namespace 的 create/promote 默认 `isPublic=true`。
3. **Daemon restart**: 以上代码变更需要重启 daemon 生效。
