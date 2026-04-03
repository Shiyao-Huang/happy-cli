# Repository Guidelines

## 0403 Sprint 架构决策

- **一个 runtime，多态全靠 genome**：所有 agent 共享 runClaude.ts，行为差异通过 Entity.spec（config + systemPrompt）实现。Runtime 不应有 role-specific 分支。
- **Prompt 在 DB 不在代码**：runClaude.ts 只从 `_agentImage.systemPrompt` 读取 prompt，用 `resolvePromptTemplateVars()` 替换 `{{}}` 占位符。代码里零行 prompt 文本。
- **Hub 直写 evidence**：`entityHub.ts` 直写 genome-hub Trial/Verdict。`sessionTrialSync.ts` 是 compat fallback，不是主链。
- **Artifact-first**：先创建 artifact（pending state），再 spawn session，再 patch。`SpawnResult` 类型替代 `string | null`。
- **`resolveEntityNsName()` + `buildVerdictContent()`** 已从 supervisorTools 闭包提取到模块作用域，可独立测试。

## Agent & Legion Construction Skills

Two living skills cover how to build good agents and teams. Use them when designing, evolving, or debugging genomes and legion templates.

| Skill | Path | Use when |
|-------|------|----------|
| `/build-agent` | `skills/build-agent/SKILL.md` | Creating or evolving an AgentImage / genome |
| `/build-legion` | `skills/build-legion/SKILL.md` | Assembling a team or publishing a LegionImage |

**Self-update convention**: After running a sprint that involves creating or significantly modifying agents/legions, open the relevant skill and append what was surprising — new anti-patterns, effective prompt changes, role combinations that worked or didn't. These skills improve through use, not through upfront design.

**周期性更新约定**：每隔一段时间（完成一次重要的 agent 构建或团队运行后），回顾并更新这两个 skill：
- 本次创建/修改了哪些 agent？有没有违反减法原则？
- 团队运行中出现了哪些新的反模式？
- E+O 因素（环境/组织）是否影响了 genome 评分判断？
- 把新发现追加到对应 skill 的减法检查表或反模式表中。

核心哲学：世界很大，游乐场很多。组装 agent 时可以尽情放开；加法减法交替做；奥卡姆剃刀和精确专业的指导同时有用。



## 动态授权系统（待实现 — 下 sprint）

Agent runtime 中增加临时工具授权插槽，消除 genome spec 静态权限粒度过粗的问题。

### 核心公式

```
effectiveAllowedTools = staticTools(genome.allowedTools)
                       ∪ temporalGrants(session, non-expired)
```

优先级链（严格）：
```
disallowedTools（永久硬禁）
  > temporalGrants（运行时动态，TTL 绑定）
    > allowedTools（genome 静态列表）
```

### opt-in 槽

Genome spec 中声明 `"@granted"` token 才能接受动态授权。没有该 token 的角色物理上无法被授权额外工具。

### 约束

- 授予者只能授予自己拥有的工具（上界约束，daemon 层硬编码）
- 每个授权带 TTL + reason（无过期 = 永久 = 等同于硬编码）
- 审计链必须记录：`grantedBy + tool + taskId + expiresAt`
- 破坏性操作永久硬禁，不进动态授权范围

### 最小实现路径

1. **DB** — `TemporaryGrant(id, sessionId, tool, grantedBy, expiresAt, reason)`（genome-hub）
2. **MCP** — `grant_tool_access(sessionId, tool, ttl_minutes, reason)` — supervisor/master 专属
3. **MCP** — `revoke_tool_access(grantId)` — 可选，提前撤销
4. **daemon** — `permissionServer.ts` 合并 staticTools + 未过期 temporalGrants

> 触发背景：0331 sprint Researcher 因 `list_available_agents` 权限不足循环失败，静态 genome 无法在不 respawn 的情况下临时授权。

---

## ESM `.mjs` helper typing rule

Any newly added ESM `.mjs` helper must ship with matching declaration files in the same change.

- Required:
  - `scripts/lib/<name>.d.ts`
  - `scripts/lib/<name>.d.mts`
- Do not send a helper to review if its declarations are missing.
- Treat missing declarations as a repository-wide typecheck blocker, not a follow-up cleanup item.

## Pre-review checklist

Before marking work as `review`, the assignee must complete this checklist:

```bash
git status
npx vitest run <changed-spec>
# If full typecheck OOMs, run focused tsc / targeted file checks instead.
```

- `git status` must confirm there are no task-related unstaged or forgotten untracked files.
- Run targeted tests for the changed area and confirm they pass.
- Run focused `tsc` / targeted type checks to confirm there is no type regression.
- If the machine hits OOM, downgrade to a narrower file-level check, but do not skip type validation entirely.
