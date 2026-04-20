# Agent JSON v1 — Complete Structure Design

## Architecture: Agent Docker Package

```
agent.json 是 Agent 的 Dockerfile + docker-compose 的结合体。

它声明了：
- 我是谁（identity）
- 我能做什么（capabilities）
- 我怎么被评价（evaluation contract）
- 我怎么进化（evolution surface）
- 我怎么被卖（market & monetization）
- 我怎么被部署（deploy defaults）

它不包含：
- 运行时状态
- 评分结果
- Session 信息
- 实际密钥
```

## Complete Field Map

```
agent.json
├── kind                          # 格式标识
├── name                          # 名称
├── description                   # 描述
├── baseRoleId                    # 继承的基础角色
├── runtime                       # 引擎类型 (claude/codex/open-code)
│
├── prompt                        # ── 身份层 ──────────────────────
│   ├── system                    #   完整 system prompt
│   └── suffix                   #   追加到默认 prompt 之后
│
├── tools                         # ── 能力层 ──────────────────────
│   ├── allowed                   #   允许的工具列表
│   ├── disallowed                #   禁用的工具列表
│   ├── mcpServers                #   MCP server 引用
│   └── skills                   #   Skill 引用（从 library 加载）
│
├── hooks                         # ── 自动化层 ────────────────────
│   ├── preToolUse[]              #   工具调用前
│   ├── postToolUse[]             #   工具调用后
│   └── stop[]                   #   会话结束时
│
├── permissions                   # ── 约束层 ──────────────────────
│   ├── permissionMode            #   权限模式
│   ├── accessLevel               #   访问级别 (read-only/full-access)
│   ├── ceiling                   #   权限上限（不可突破）
│   ├── executionPlane            #   执行面 (mainline/bypass)
│   └── maxTurns                 #   最大轮次
│
├── env                           # ── 环境层 ──────────────────────
│   ├── required                  #   必须的环境变量
│   └── optional                 #   可选的环境变量
│
├── context                       # ── 协作层 ──────────────────────
│   ├── teamRole                  #   团队角色名
│   ├── capabilities              #   能力标签
│   ├── messaging                 #   消息行为
│   │   ├── listenFrom            #     监听谁 ("*" 或 角色列表)
│   │   ├── receiveUserMessages   #     是否接收用户消息
│   │   └── replyMode            #     proactive/responsive/passive
│   └── behavior                 #   行为模式
│       ├── onIdle                #     空闲时: wait/self-assign/ask
│       ├── onBlocked             #     阻塞时: report/escalate/retry
│       ├── canSpawnAgents        #     能否 spawn 子 agent
│       └── requireExplicitAssignment  # 需要显式分配才工作
│
├── routing                       # ── 路由层 ──────────────────────
│   ├── strategy                  #   fixed/failover
│   ├── providerOrder             #   提供商优先级
│   ├── models                    #   模型映射
│   │   ├── default               #     默认模型
│   │   ├── fast                  #     快速任务
│   │   ├── balanced              #     平衡
│   │   ├── deep                  #     深度推理
│   │   └── reasoning            #     复杂推理
│   └── constraints              #   硬限制（预留）
│
├── evaluation                    # ── 评价层 ──────────────────────
│   ├── criteria                  #   评分维度 (delivery/integrity/...)
│   ├── scoreSchemaVersion        #   评分 schema 版本
│   ├── logKinds                  #   需要的日志类型
│   └── benchmarks               #   基准测试绑定 (NEW)
│       ├── suite                 #     测试套件名
│       └── passingScore         #     及格线
│
├── evolution                     # ── 进化层 ──────────────────────
│   ├── enabled                   #   是否参与进化
│   ├── parentRef                 #   父代引用 (@ns/name:version)
│   ├── parentDigest              #   父代指纹
│   ├── mutationNote              #   变异说明
│   ├── mutablePaths              #   可变异的字段路径
│   ├── scoreTargets              #   优化目标维度
│   ├── strategy                  #   变异策略 (NEW)
│   │   ├── type                  #     random/directed/guided
│   │   └── temperature          #     变异幅度 (0-1)
│   ├── population                #   种群管理 (NEW)
│   │   ├── maxVariants           #     最多保留几个变体
│   │   ├── selectionPressure     #     淘汰压力 (low/medium/high)
│   │   └── minSessions          #     最少跑几次才评价
│   └── rollback                 #   回滚策略 (NEW)
│       ├── autoRollback          #     自动回滚开关
│       └── rollbackThreshold    #     低于此分数自动回滚
│
├── market                        # ── 市场层 ──────────────────────
│   ├── namespace                 #   发布者 (@official, @user)
│   ├── category                  #   分类 (coordination/development/...)
│   ├── tags                      #   搜索标签
│   ├── lifecycle                 #   experimental/active/deprecated
│   ├── license                   #   许可证类型 (NEW)
│   ├── pricing                   #   定价 (NEW)
│   │   ├── model                 #     free/paid/usage-based/subscription
│   │   ├── unitPrice             #     单价（若 usage-based）
│   │   ├── unit                  #     计费单位 (session/hour/turn)
│   │   └── trial                #     试用配额
│   │       ├── enabled           #       是否有试用
│   │       └── quota            #       试用额度
│   └── revenue                  #   收益分成 (NEW)
│       ├── creatorShare          #     创建者分成比例 (0-1)
│       └── platformShare        #     平台分成比例 (0-1)
│
├── deploy                        # ── 部署层 (NEW) ────────────────
│   ├── workspaceMode             #   shared/isolated
│   └── resourceLimits           #   资源限制
│       ├── maxConcurrentTools    #     最大并发工具数
│       └── timeoutMinutes       #     超时分钟数
│
├── package                       # ── 包层 ─────────────────────
│   ├── ref                       #   包引用 (@ns/name:version)
│   └── digest                   #   内容指纹 (sha256:...)
│
└── meta                          # ── 扩展元数据 ──────────────────
```

## Section 归类：Docker 类比

| Section | Docker 类比 | 性质 | 谁写 |
|---------|------------|------|------|
| `prompt` | `CMD` / `ENTRYPOINT` | 身份 — 不可运行时覆盖 | 作者 |
| `tools` | `EXPOSE` / 安装包 | 能力声明 | 作者 |
| `hooks` | `HEALTHCHECK` | 自动化 | 作者 |
| `permissions` | `--cap-add/drop` | 安全约束 | 作者 + 平台 |
| `env` | `ENV` / `ARG` | 环境契约 | 作者声明，部署者注入 |
| `context` | `--network` | 协作配置 | 作者 |
| `routing` | `--runtime` | 引擎路由 | 作者，可覆盖 |
| `evaluation` | 无直接类比 | 评价合约 | 作者 |
| `evolution` | 无直接类比 | 进化策略 | 作者 + 平台 |
| `market` | Docker Hub listing | 商业化 | 作者 |
| `deploy` | `docker run` flags | 部署策略 | 部署者（可覆盖） |
| `package` | Image tag + digest | 版本追踪 | 注册表 |

## Evolution 完整生命周期

```
  agent.json v1 (parent)
       │
       ▼
  supervisor 评分 → genome-hub 记录
       │
       ├─ 分数 OK → promote (升级到 active)
       │
       └─ 分数不够 → mutate
              │
              ▼
         evolution.strategy 决定变异方式：
         ├── random:   随机调整 mutablePaths 内的值
         ├── directed: 根据低分维度定向调整
         └── guided:   人工指定变异方向（mutationNote）
              │
              ▼
         生成 agent.json v2 (child)
         ├── parentRef = @official/supervisor:1
         ├── parentDigest = sha256:abc...
         └── mutationNote = "提高 routing.models.default 到 opus"
              │
              ▼
         population 管理：
         ├── 跑 minSessions 次
         ├── 对比 scoreTargets 维度
         ├── 保留 top maxVariants 个变体
         └── 淘汰其余（selectionPressure）
              │
              ├─ v2 分数 > v1 → v2 成为新 active
              ├─ v2 分数 < rollbackThreshold → 自动回滚到 v1
              └─ v2 分数 中间 → 保留观察，等更多 session 数据
```

## Market 商业化模型

```
免费模式 (free):
  pricing.model = "free"
  → 所有人可用，无限制

按量计费 (usage-based):
  pricing.model = "usage-based"
  pricing.unit = "session"
  pricing.unitPrice = 0.05
  → 每个 session $0.05

订阅制 (subscription):
  pricing.model = "subscription"
  pricing.unitPrice = 9.99
  pricing.unit = "month"
  → $9.99/月

带试用 (trial):
  pricing.trial.enabled = true
  pricing.trial.quota = 10
  → 前 10 次免费

收益分成:
  revenue.creatorShare = 0.7
  revenue.platformShare = 0.3
  → 创建者拿 70%，平台拿 30%
```

## Deploy 层：为什么要跟主体分开

`deploy` 是唯一一个 **"不是 agent 自己说了算"** 的 section。

同一个 agent.json，不同场景 deploy 不同：

| 场景 | workspaceMode | 为什么 |
|------|--------------|--------|
| 团队协作 | `shared` | 多 agent 改同一个 repo |
| Evolution 试跑 | `isolated` | 每个变体独立 worktree |
| CI/CD 检验 | `isolated` | 隔离防止互相污染 |
| 单 agent 开发 | `shared` | 不需要隔离 |

agent.json 里写的是 **默认值**，启动时可覆盖。

## Runtime Materialization 流程

```
agent.json
    │
    ▼
CLI materializer (prepareAgentRuntime)
    │
    ├─ 1. 读取 agent.json
    │
    ├─ 2. 解析 deploy.workspaceMode
    │     ├─ shared  → cwd = 项目目录
    │     └─ isolated → 创建 worktree, cwd = worktree
    │
    ├─ 3. 展开 runtime 环境
    │     ├─ hooks    → 生成 settings.json → --settings flag
    │     ├─ skills   → 从 library 读取 → prompt injection
    │     ├─ mcp      → 组装 config → --mcp-config flag
    │     ├─ env      → 验证 + process.env 注入
    │     └─ maxTurns → --max-turns flag
    │
    ├─ 4. 启动 claude/codex/open-code
    │
    └─ 5. cleanup on exit
         ├─ 删除临时 settings.json
         ├─ 清理 worktree（如果 isolated）
         └─ 更新 runtime 状态
```
