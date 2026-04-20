# Aha v3 Team Deliveries — Isolated Sprint Note

> 内部说明：本文件单独隔离记录“通过 team 协作完成、且可能影响运行时/CLI/Agent 行为”的交付，便于后续单独评估影响范围。

---

## 为什么单独记录

这一轮交付不是单点改动，而是跨越了：

- runtime materialization
- CLI 命令面
- team / agent 启动链路
- Docker/CI 测试体系
- model awareness / model control plane

因为这些改动的影响面较大，所以不把它们分散埋在各个参考文档里，而是集中在这里做一份隔离说明。

---

## 本轮通过 Team 协作完成的交付

### 1. Agent workspace materialization 主链路

- `materializer v1` 已落地
- `buildAgentWorkspacePlanFromGenome()` 已接入 genome-backed session
- `settingsPath` 链路已贯通到 Claude 启动参数 `--settings`
- `effectiveCwd` 已切换为：
  - genome workspace 存在时用 `_workspacePlan?.effectiveCwd`
  - 否则回退 `workingDirectory`

### 2. runtime-lib 共享资源层

已实现共享运行时库结构：

```text
~/.aha/runtime-lib/
├── skills/
├── mcp/
├── prompts/
├── hooks/
└── tools/
```

并支持：

- `linkSharedResource()`：共享只读资源 symlink
- `copyPrivateResource()`：私有/可变资源 copy
- `materializationPolicy`：按资源或 skill 决定 link vs copy

### 3. `.genome/` workspace overlay

当 genomeSpec 可用时，agent workspace 现在会写入：

```text
.genome/
├── spec.json
├── lineage.json
└── eval-criteria.md
```

同时补充：

- `__genome_ref__` context injection
- `specId` / `version` / lineage 快照

这意味着 agent 启动后可以“知道自己是谁、从哪里来、按什么标准被评估”。

### 4. CLI 增强

#### `aha sessions`

新增：

- `aha sessions list`
- `aha sessions show <sessionId>`
- `aha sessions archive <sessionId>`
- `aha sessions delete <sessionId>`

#### `aha agents spawn`

支持：

```bash
aha agents spawn <path/to/agent.json> --team <teamId> --role <roleId> --path <cwd>
```

流程：

1. 读取并校验 `agent.json`
2. 本地物化 workspace
3. 通过 daemon spawn session
4. 可选加入 team roster

### 5. Docker / CI 测试体系

当前已完成：

- L1 schema 校验
- L2 materializer smoke 校验
- L3 hook / skill 机制验证
- L4 静态合同检查

说明：

- CI/机制层已通过
- 真实 AI liveness / skill / hook E2E 依赖 `ANTHROPIC_API_KEY`
- 无密钥环境下按设计 `skip`

### 6. 模型控制与模型自知

#### 模型切换控制面

已支持：

```bash
aha agents update <sessionId> --model <modelId> --fallback-model <fallbackModelId>
```

并新增 MCP tool：

- `update_agent_model`

#### Agent 模型自知

已增加：

- `MODEL_CONTEXT_WINDOWS`
- `resolveContextWindowTokens()`
- `buildModelSelfAwarenessPrompt()`

运行中的 agent 现在可以在系统提示里知道：

- 当前模型
- fallback 模型
- context window 大小

`aha sessions show` 也可显示：

- `resolvedModel`
- `contextWindowTokens`

### 7. 文档补齐

已产出：

- `docs/aha-v3-agent-guide.md`
- `docs/aha-v3-cli-reference.md`
- `skills/aha-v3-reference/SKILL.md`

这些文档覆盖了 agent 内部视角、CLI 外部视角和快速 skill 查阅入口。

---

## 影响面判断

### 已确认稳定的部分

- `yarn build` 通过
- materializer 相关测试通过
- CLI 帮助与 sessions 命令可用
- settings / hooks / genome overlay 链路已打通

### 需要单独注意的部分

- 这批改动影响了 runtime 启动与 session metadata
- Docker E2E 中真实 AI 行为仍依赖密钥环境
- marketplace / evolution 的更深层实现被明确留到 P2，不混在本轮交付里

---

## 建议怎么阅读本轮变更

如果你只关心“用户可见的新能力”，优先看：

1. `docs/aha-v3-cli-reference.md`
2. `docs/aha-v3-agent-guide.md`

如果你关心“这轮 team 协作到底改了哪些底层”，优先看：

1. 本文件
2. `docs/agent-runtime-materializer-v1.md`
3. `src/agentDocker/materializer.ts`

---

## 当前结论

这轮通过 team 完成的交付，已经从“概念设计”推进到了“可运行的基础设施”：

- 可以从 `agent.json` 物化 workspace
- 可以通过 CLI 直接 spawn agent
- 可以把 runtime / genome / model awareness 串起来
- 可以用 CI 验证大部分机制层正确性

P2 是否继续扩展 marketplace / evolution / fully-isolated git worktree，可以在此基础上继续推进。
