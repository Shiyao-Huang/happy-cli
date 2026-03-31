# Repository Guidelines

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
