# /build-legion

构建高质量 LegionImage（团队模板）的实战指南。

用于：设计新团队模板、通过 `create_corps` 发布 LegionImage、调整团队配置时。

---

## 核心哲学

**Legion 不是 agent 的堆砌，是角色的编排。**

一个好的团队模板解决的问题是：**谁来做什么决定，通过什么通道传递**。

两条互补原则：
- **加法**：先从任务出发，问"这个任务如果一个人做，会在哪里卡住？那里就需要另一个角色"
- **减法**：每加一个角色，问"没有它，团队能否自行解决？" 能就不加

---

## Legion 解剖：四层结构

```
1. 成员层   AgentImage[] — 每个成员的 genome 引用 + 版本
2. 协议层   bootContext.taskPolicy — 团队任务驱动规则
3. 角色图   谁向谁汇报、谁能 spawn、谁是 bypass
4. 触发层   何时激活 master、何时需要 supervisor
```

---

## 构建流程

### 第一步：从任务反推角色

列出目标任务的关键决策点：

```
任务：构建一个 API 功能
决策点：
- 拆分子任务 → 需要 master
- 写代码 → 需要 implementer / builder
- review 代码 → 需要 reviewer（可选，取决于质量要求）
- 部署 → 需要 builder 或 devops（取决于复杂度）
```

**从最小团队开始**，只有当某个决策点确实需要专门角色时才增加。

### 第二步：master 是必须的，supervisor 是可选的

每个 legion 都需要一个 **master**（协调）。

**supervisor 只在以下情况才有价值**：
- 团队运行周期超过数小时
- 需要自动进化 genome
- 需要评分和质量保障循环

短期冲刺团队（< 2 小时）：master 足够，不需要 supervisor。

### 第三步：定义 bootContext

bootContext 是团队启动时的"共同理解"，必须包含：

```json
{
  "bootContext": {
    "objective": "一句话描述团队的核心目标",
    "successCriteria": ["具体的可验收条件"],
    "taskPolicy": {
      "autoAssign": true,
      "priorityOrder": ["urgent", "high", "medium", "low"]
    }
  }
}
```

**objective 写不出来 = 团队还没准备好发布**。

### 第四步：角色通信协议

决定三件事：

1. **谁接受用户消息**（receiveUserMessages: true）— 通常只有 master
2. **谁能 spawn agents**（canSpawnAgents: true）— master + 可能的 org-manager
3. **谁是 bypass**（executionPlane: bypass）— org-manager 类的元角色，不参与任务执行

### 第五步：版本锁定

发布 legion 时，引用的每个 AgentImage 都要锁定版本：

```json
"members": [
  { "role": "master", "genomeRef": "@official/master@5" },
  { "role": "implementer", "genomeRef": "@official/implementer@3" }
]
```

不要用 `latest` — 团队行为需要可重现。

---

## 团队规模指南

| 任务类型 | 推荐配置 |
|---------|---------|
| 单文件改动 | 1 implementer（不需要 master） |
| 小功能（< 1天） | master + 1-2 implementer |
| 中等 sprint | master + 2-3 builder/implementer + 1 reviewer |
| 长期团队 | master + supervisor + 专项角色 |
| 研究/诊断 | master + researcher + 1 helper |

**超过 6 人的团队极少必要。** 如果你觉得需要 7 个人，先问：能不能通过更清晰的任务拆分让更小的团队完成？

---

## 减法检查（发布前）

| 角色 | 问题 |
|------|------|
| 每一个 builder/implementer | 如果只保留一个，团队哪里会卡？ |
| reviewer | 没有 reviewer，代码质量会如何保证？（如果 implementer 有 evalCriteria 就可以不加） |
| researcher | 有没有信息获取的明确需求？还是 implementer 也能搜索？ |
| supervisor | 运行周期超过 2 小时吗？需要自动进化吗？ |

---

## 常见反模式

| 反模式 | 症状 | 解法 |
|--------|------|------|
| 角色重叠 | 两个 agent 在等同一个任务 | 合并角色或明确分工边界 |
| 协调过重 | master 消息比 implementer 多 | 检查 taskPolicy，减少汇报要求 |
| 孤立 agent | 某角色没有收到任何 mention | 这个角色不需要，删除 |
| 无边界 executor | 一个 builder 在改所有文件 | scopeOfResponsibility 限制写入范围 |
| 永远 blocked | agent 在等另一个 agent | 检查依赖链，是否有循环等待 |

---

## Legion vs 单 agent 的判断

> 如果任务可以被一个熟练 agent 在一个 context window 内完成，就不需要 legion。

Legion 的价值在于：
- **并行**：多个 agent 同时工作
- **专业化**：不同角色有不同 genome（不同的评分标准、不同的工具）
- **长周期**：超出单 context window 的工作需要跨 session 协调

---

## 本 skill 的自更新约定

**每次创建或运行团队模板后，用这个 skill 回顾一次**：
- 哪个角色是多余的？
- 哪里出现了协调瓶颈？
- bootContext 的 objective 是否准确描述了团队实际做的事？

把新发现的模式（好的或坏的）追加到本文件的减法检查表或反模式表中。
