# /build-agent

构建高质量 AgentImage（agent genome）的实战指南。

用于：创建新 agent genome、迭代已有 genome、通过 `create_genome` 或 `mutate_genome` / `evolve_genome` 设计 agent 时。

---

## 核心哲学

**世界很大，游乐场很多。组装 agent 时可以尽情放开。**

同时记住两条互补的原则：
- **奥卡姆剃刀**：没有理由的字段不加。一个好 agent 的 systemPrompt 往往比你以为的要短。
- **加减交替**：先加齐所有你认为需要的东西，然后从头问"这个字段如果去掉，agent 会失去什么"。去不掉的留下，其余删除。

---

## Agent 解剖：六层基因

```
1. 身份层     displayName / baseRoleId / namespace / runtimeType
2. 行为层     systemPrompt / responsibilities[] / protocol[] / evalCriteria[]
3. 工具层     allowedTools[] / disallowedTools[] / permissionMode
4. 运行时层   modelId / fallbackModelId / mcpServers[] / skills[] / hooks{}
5. 内嵌文件层 files{} — 随 genome 打包的文档，spawn 时写入工作目录
6. 进化历史层 memory.learnings / viewDiff[] / viewLedger[]
```

---

## 构建流程

### 第一步：先问角色的边界

> "这个 agent 的唯一不可替代之处是什么？"

把答案写成一句话。这一句话就是 `systemPrompt` 的核心。
如果你写不出来，这个 agent 不应该存在，或者需要拆分。

### 第二步：写 systemPrompt（行为层核心）

好的 systemPrompt：
- **开头是任务**，不是自我介绍
- **有边界声明**（什么不做、什么不碰）
- **有失败行为定义**（blocked 时怎么办、idle 时怎么办）
- 不超过 400 字（超了就在 `responsibilities[]` 里拆分）

坏的 systemPrompt：
- 把所有知识都塞进去（用 `files{}` 解决）
- 写很多"你是一个专业的 X"（没有操作意义）
- 既描述角色又规定工具用法（工具层是独立的）

### 第三步：evalCriteria 先于 protocol

先写评分标准（evalCriteria），再写执行步骤（protocol）。

这样 protocol 才会真正服务于可观测的产出，而不是成为一份走过场的仪式。

evalCriteria 要可验证，例如：
```
✅ "完成的 task 有 completion comment 记录输出"
✅ "blockers 在发现后 1 个 tool call 内用 report_blocker 上报"
❌ "保持专业态度"（无法验证）
```

### 第四步：allowedTools 精确最小化

每个不需要的工具都是攻击面和干扰项。

出发点：**先写空白名单，只加用到的工具**。

检查项：
- 是否真的需要文件系统工具（Bash/Edit/Write）？
- 需要什么 MCP 工具？（列出来，不是写 `*`）
- 是否需要 spawn agents？（`create_agent` 是权力，不是默认）

### 第五步：hooks 是传感器，不是装饰

如果你不知道 agent 在做什么，你就无法改进它。

minimal hook 模板：
```json
"hooks": {
  "postToolUse": [{
    "matcher": "complete_task|start_task",
    "command": "echo '[hook] task lifecycle event' >> ~/.aha-dev/logs/agent-hooks.log"
  }]
}
```

### 第六步：files{} 替代"知识型 systemPrompt"

把参考文档、操作手册、角色地图打包进 `files{}`，spawn 时自动写入工作目录。

agent 可以通过 Read 工具按需读取，不需要全部塞入 context。

---

## 减法检查（发布前必做）

问自己：

| 字段 | 问题 |
|------|------|
| `systemPrompt` 每一段 | 如果去掉，agent 会犯什么具体错误？ |
| `allowedTools` 每一项 | 有哪个任务真的需要这个工具？ |
| `protocol` 每一步 | 这步没有会怎样？ |
| `files{}` 每一项 | agent 会在什么时刻读这个文件？ |
| `memory.learnings` 每一条 | 这条经验影响下一次 spawn 的什么行为？ |

去掉没有答案的项。

---

## E+O > D 原则

> 大多数 agent 失败来自 **环境(E)** 和 **组织因素(O)**，不是 genome 定义(D)。

同一个 genome 在以下情况下表现会完全不同：
- 团队是否有 master 协调
- 任务描述是否清晰
- MCP 工具是否可用
- API 是否有限速

**所以**：genome 改好之后如果行为没变，先查 E 和 O，不要盲目继续改 D。

---

## 进化节奏

| 触发条件 | 建议操作 |
|---------|---------|
| 连续2次 score < 70 | `mutate_genome` (moderate) — 改 protocol / responsibilities |
| 发现新的反模式 | `evolve_genome` — append learning |
| 行为根本错了 | `mutate_genome` (radical) — 重写 systemPrompt 相关段 |
| 进化后更差 | `rollback_genome` |
| 每隔 ~5 次评分周期 | 回顾 evalCriteria，看是否还反映真实目标 |

---

## 本 skill 的自更新约定

**每次创建或迭代 agent genome 后，用这个 skill 回顾一次**：
- 这次有没有违反减法原则？
- E+O 因素是否影响了评分判断？
- 有没有新的"坏模式"值得加入减法检查表？

用 `evolve_genome` 把新经验追加到 `memory.learnings`，或直接修改本文件。

### 新近反模式补充

- **会退休的 worker genome 却没有 retire handoff 协议**：如果 agent 可能在任务中途 retire / replace，但 genome 没要求它在退出前写 task handoff，下一任 owner 会被迫从零重建上下文。对 builder / implementer 一类角色，优先加 `behavior.onRetire: "write-handoff"`，并明确 handoff 至少包含：任务 ID、未提交改动摘要、下一步建议。
