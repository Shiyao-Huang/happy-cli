# ClawTeam → Aha 概念映射表

> 将 [ClawTeam](https://github.com/HKUDS/ClawTeam) Swarm Intelligence 模式蒸馏为 Aha Legion Image 和 Agent Image 的对照参考。
>
> 蒸馏产物：`@public/swarm-leader` · `@public/swarm-worker` · `@public/clawteam-swarm`

---

## 核心概念映射

| ClawTeam 概念 | Aha 对应概念 | 说明 |
|---|---|---|
| Team | Legion | 多 agent 协作单元 |
| Team Template | LegionImage | 可复用的团队模板，存储于 marketplace |
| Leader Agent | `swarm-leader` AgentImage | 协调角色，任务分解 + Auftragstaktik 委托 |
| Worker Agent | `swarm-worker` AgentImage | 执行角色，Boids 自组织 + 元认知自评 |
| Supervisor | supervisor AgentImage | 监控评分，Circuit Breaker 检测 |
| Task / Subtask | Kanban Task / subtaskIds | 任务板驱动执行，依赖链显式声明 |
| Task DAG | subtaskIds + parentTaskId | 有向无环依赖图映射到 kanban 层级 |
| Inter-agent Messaging | `send_team_message` MCP | 跨 agent 通信的统一 MCP 接口 |
| Auftragstaktik | genome.responsibilities | "说 WHAT 不说 HOW"，委托意图而非步骤 |
| Circuit Breaker | `report_blocker` escalation | 3 次失败 → report_blocker → 自动升级 |
| Swarm Self-organization | Boids Rules (separation/alignment/cohesion) | Worker genome 内置群体协调行为规则 |
| Team Templates | corps marketplace | LegionImage 发布到 genome-hub marketplace |
| Agent Spec | AgentImage (genome spec) | 完整 agent 定义：prompt + tools + hooks + env |
| Agent Evolution | `evolve_genome` (AgentPlug) | genome 版本化进化，Plug 差量应用 |
| Shared Memory / State | Kanban board + task comments | 任务状态和 handoff 上下文持久化 |

---

## 架构差异

| 维度 | ClawTeam | Aha |
|---|---|---|
| 存储层 | 本地文件系统 | genome-hub 服务器（DB） |
| 团队同步 | 无（单机） | 跨机器 WebSocket 实时同步 |
| Agent 复用 | 代码层配置 | Marketplace AgentImage，可发现、可评分 |
| Agent 进化 | 无 | evolve_genome → Plug 差量 → 版本化 |
| 权限控制 | 无 | allowedTools / disallowedTools + 动态授权 TTL |
| 评分与学习 | 无 | score_agent → genome feedback loop |
| 运行时入口 | 直接调用 | daemon + MCP permission server |

---

## ClawTeam Swarm 蒸馏产物

### swarm-leader AgentImage
- **角色**: 协调，禁止直接写代码
- **核心行为**: 任务分解 DAG + Auftragstaktik 委托（说 WHAT 不说 HOW）+ Plan Approval + Circuit Breaker（healthy → degraded → open）
- **工具**: Read/Glob/Grep + 全套 kanban + create_agent；禁止 Edit/Write/Bash
- **evalCriteria**: 子任务有依赖声明、意图委托、计划审批、degraded 1 cycle 内响应

### swarm-worker AgentImage
- **角色**: 执行，有代码权限
- **核心行为**: Plan First（编码前提交计划）+ 自主执行 + Boids 自组织（separation/alignment/cohesion）+ 元认知自评 + Circuit Breaker（3 次失败 → report_blocker）
- **工具**: Read/Edit/Write/Bash/Glob/Grep + kanban 生命周期；禁止 create_agent/create_task/score_agent/evolve_genome
- **evalCriteria**: 计划先于代码、scope 隔离、测试通过、commit hash 记录

### clawteam-swarm LegionImage
- **结构**: 1 Leader + 3 Workers + 1 Supervisor
- **bootContext.objective**: 分解目标 → 并行 swarm 执行 → 综合结果
- **taskPolicy**: planApprovalRequired=true, maxParallelWorkers=3
- **swarmProtocol**: auftragstaktik + circuitBreaker(degraded 2min, open 5min) + boidsRules

---

## Marketplace 索引

搜索关键词：`swarm`

| 产物 | ID | 类型 |
|---|---|---|
| swarm-leader | `cmnrmkxn500stfin5v1chm38o` | AgentImage |
| swarm-worker | `cmnrmm06c00sufin5ee4hj19q` | AgentImage |
| clawteam-swarm | `cmnrmmrw100svfin5drs2rn1v` | LegionImage |
