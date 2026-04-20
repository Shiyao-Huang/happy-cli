# Aha CLI npm 包代码安全加固方案（2026-03-26）

## 结论先行

**推荐主方案：`pkg/bun compile` 路线作为近期发布形态**，并把**少数真正带信任边界的高敏写操作继续/进一步服务端化**，形成“两段式”方案：

1. **近期（推荐立即立项）**：把公开 npm 分发从“可读 JS bundle”切到“平台二进制 + npm thin wrapper”。
2. **中期（推荐并行规划）**：把真正不该留在客户端的写操作与密钥依赖链继续收缩到服务端代理。

原因：
- 用户当前担心的是 **npm 发布后代码和机制容易被直接逆向**；compile 方案是**最直接降低可读性**、同时**不需要立刻重构整个产品架构**的路径。
- 但 compile **不能真正保护所有机密逻辑**：任何仍在本地执行、且拥有本地 token / 本地控制权的逻辑，依然只是“更难看懂”，不是“不可获取”。
- 因此最终正确方向不是“只混淆”，而是：
  - **分发层**：compile，去掉公开可读 JS；
  - **信任层**：服务端化真正高敏的写操作与策略依赖。

---

## 当前发布面现状（审计事实）

### 1. 当前 npm 包是公开发布

`package.json` 当前配置：
- `publishConfig.registry = https://registry.npmjs.org`
- `publishConfig.access = public`

### 2. 当前发布包虽不含 `src/`，但含大量**可读 dist JS**

`npm pack --dry-run --json` 显示当前公开包至少包含：
- `dist/**/*.cjs|mjs`
- `bin/aha.mjs`, `bin/aha-mcp.mjs`
- `scripts/*`
- `schemas/*`
- `examples/agent-json/*`
- 文档与工具归档

这意味着：
- **源码目录没发出去 ≠ 逻辑没暴露**
- 现在暴露的是**构建后的、但仍高度可读的 JS bundle**

### 3. 发布产物中可直接搜到敏感字符串与协议名

在 `dist/` 中可直接检索到：
- `Authorization: Bearer ...`
- `HUB_PUBLISH_KEY`
- `genomeHubPublishKey`
- `/spawn-session`
- `/team-pulse`
- `request_help`

这说明当前 npm 包已足够让外部使用者恢复出：
- 本地 daemon 控制面协议
- MCP / team / supervisor 关键机制
- genome marketplace 写路径
- token / publish-key 依赖链

---

## 暴露面分层（按敏感度）

下面不是“哪些文件有秘密字符串”这么简单，而是“哪些模块承载了**不适合公开可读分发**的能力”。

## A. **绝对高敏：凭证、密钥、身份、发布权限链**

### 关键模块
- `src/persistence.ts`
- `src/configurationResolver.ts`
- `src/auth/reconnect.ts`
- `src/commands/auth.ts`
- `src/api/api.ts`
- `src/api/apiSession.ts`

### 为什么高敏
这些模块共同定义了：
- 本地 `~/.aha` / `~/.aha-v3` 的凭证与 settings 持久化
- `machineId`、`contentSecretKey` / `machineKey` / reconnect seed 的保存和恢复路径
- `genomeHubPublishKey` 的读取与 fallback
- Bearer token 的实际使用方式
- genome promote / create / feedback 等写操作的认证链

### 风险
即使代码里不直接硬编码生产密钥，**认证模型、凭证存储格式、fallback 行为、请求路径** 都被完整公开，降低攻击者理解成本。

---

## B. **绝对高敏：本地 privileged control plane（daemon / session 控制协议）**

### 关键模块
- `src/daemon/controlServer.ts`
- `src/daemon/sessionManager.ts`
- `src/daemon/run.ts`
- `src/daemon/runEnvelope.ts`
- `src/modules/common/registerCommonHandlers.ts`
- `src/channels/commandExecutor.ts`
- `src/channels/router.ts`
- `src/utils/spawnAhaCLI.ts`
- `src/claude/runClaude.ts`
- `src/codex/runCodex.ts`

### 为什么高敏
这些模块定义了 Aha 本地控制面的真实能力边界。

`controlServer.ts` 当前暴露了 **17 个 POST 控制端点**，包括：
- `/session-command`
- `/stop-session`
- `/stop-team-sessions`
- `/spawn-session`
- `/team-pulse`
- `/help-request`
- `/channels/notify`
- `/list-team-sessions`
等

`registerCommonHandlers.ts` 又进一步定义了底层能力：
- `bash`
- `readFile`
- `writeFile`
- `listDirectory`
- `ripgrep`
- `difftastic`

这本质上是本地 agent runtime 的**最核心远程执行面**。

### 风险
公开可读分发会让外部非常容易理解：
- daemon 如何拉起 / 管理 session
- session 如何通过 webhook / heartbeat / session-tag 被识别
- 哪些本地 RPC 能执行 shell / 读写文件 / 控制团队

这部分不是“业务逻辑”，而是**平台控制平面**。

---

## C. **高敏：MCP 工具注册与组织运行机制**

### 关键模块
- `src/claude/mcp/index.ts`
- `src/claude/mcp/agentTools.ts`
- `src/claude/mcp/supervisorTools.ts`
- `src/claude/mcp/teamTools.ts`
- `src/claude/mcp/taskTools.ts`
- `src/claude/mcp/contextTools.ts`
- `src/claude/mcp/evolutionTools.ts`
- `src/codex/ahaMcpStdioBridge.ts`

### 为什么高敏
这层定义了 Aha 作为“组织化 agent 平台”最有价值的产品机制：
- 工具集合
- 调用权限
- 监督 / 评分 / 进化 / 替换链
- daemon 与 MCP 的耦合方式
- HTTP MCP ↔ STDIO MCP bridge 结构

当前 MCP 注册总量约 **55 个工具**。这已经不是普通 CLI，而是完整的 agent operating system 暴露面。

### 风险
如果公开可读：
- 产品差异化机制被完整学习 / 模仿
- 攻击者更容易围绕 tool surface 设计 prompt injection / misuse 路径
- 竞争对手可直接复刻 orchestration layer 的大部分行为模型

---

## D. **高敏：组织策略 / prompt 注入 / failover / help lane 规则**

### 关键模块
- `src/claude/team/promptBuilder.ts`
- `src/claude/team/alwaysInjectedPolicies.ts`
- `src/claude/team/helpLane.ts`
- `src/orgDocker/orgRulesLoader.ts`
- `src/utils/agentLaunchContext.ts`

### 为什么高敏
这部分不是秘密“凭证”，但属于**策略性 IP**：
- 任务从哪里来
- agent 如何升级 / 挑战 / 投票 / 失败转移
- org-rules 如何注入 prompt
- @help / request_help 如何触发系统行为
- agent 启动时如何收到边界、约束、上下文镜像

### 风险
公开后更容易被：
- 针对性规避 / 绕过
- 低成本模仿 Aha 的团队编排协议
- 用于逆向系统行为、构造更有效的“游戏化攻击”

---

## E. **中高敏：marketplace / evolution / feedback 同步链**

### 关键模块
- `src/utils/genomeMarketplace.ts`
- `src/claude/utils/genomePromotionSync.ts`
- `src/claude/utils/genomeFeedbackSync.ts`
- `src/utils/marketplaceConnection.ts`
- `src/claude/mcp/supervisorTools.ts`

### 为什么高敏
这些模块定义了：
- marketplace 搜索与 publish / promote 路径
- 何时直连 genome-hub，何时回退到 happy-server proxy
- publish key / auth token 的组合方式
- 评分如何同步到 marketplace

### 风险
这层同时包含：
- **写权限入口知识**
- **策略 fallback 细节**
- **marketplace 进化闭环机制**

非常不适合长期以“可读 JS”公开交付。

---

## F. **中高敏：外部渠道 token 桥接（WeChat 等）**

### 关键模块
- `src/channels/weixin/bridge.ts`
- `src/channels/weixin/auth.ts`

### 为什么高敏
虽然 token 不是硬编码的，但代码完整暴露了：
- 渠道 token 头格式
- contextToken 依赖模型
- long-poll 协议
- 重试 / backoff / queue 机制

### 风险
外部渠道接入结构被高度透明化。

---

## G. **可公开但仍建议降敏：普通 UI / tracing / 通用工具层**

### 相对较低风险模块
- `src/ui/**`
- `src/trace/**`
- `src/parsers/**`
- `src/modules/difftastic/**`
- `src/modules/ripgrep/**`

这些不是本次重点，不需要优先服务端化。

---

## 四个候选方案对比

| 方案 | 保护强度 | 对当前架构扰动 | 对 npm 用户体验 | 是否真正移除高敏逻辑 | 结论 |
|---|---:|---:|---:|---:|---|
| `pkg/bun compile` | 7/10 | 5/10 | 8/10 | 3/10 | **近期最佳** |
| 核心服务端化 | 10/10 | 9/10 | 6/10 | 10/10 | **长期正确方向** |
| JS 混淆 | 3/10 | 3/10 | 9/10 | 0/10 | **不建议单独采用** |
| 私有 registry | 4/10 | 2/10 | 5/10 | 0/10 | **只适合分发控制，不是保护** |

### 方案 1：`pkg/bun compile`

**优点**
- 最快降低“npm 一安装就能读懂 dist JS”的问题
- 保留 CLI 交互模型与本地 daemon 架构
- 用户感知变化相对小

**缺点**
- 不是安全边界，只是提高逆向成本
- 当前包不只是 CLI bin，还暴露 `exports`（`.` / `./lib` / `./codex/ahaMcpStdioBridge`）
- 要改成 compile 路线，通常意味着：
  - npm 包变成 wrapper / downloader，或
  - 分离 library package 与 CLI package
- 对动态 import、child_process、外带 tools archive、native 依赖兼容性要做 spike

**判断**
- **适合作为近期主方案**
- 但不能被误当成“真正机密保护”

### 方案 2：核心服务端化（thin client）

**优点**
- 唯一真正把高敏逻辑从包里移走的方法
- 可彻底移除 publish/promote 权限链、marketplace 写操作、策略性 orchestration IP 的客户端暴露

**缺点**
- 架构改动最大
- 会影响离线能力、本地 daemon 责任划分、运维复杂度
- 需要重新划分“必须本地”的部分和“必须服务端”的部分

**判断**
- **长期最正确**
- 但不适合作为“立刻止血”的唯一动作

### 方案 3：JS 混淆

**优点**
- 上线快
- 几乎不改分发方式

**缺点**
- 只防君子，不防有动机的逆向
- 会显著恶化调试、错误栈、用户支持、开源协作
- 对已经公开的协议名、端点名、流程结构保护很弱

**判断**
- **不建议单独采用**
- 最多只能作为 compile 前的临时补丁，但价值有限

### 方案 4：私有 npm registry

**优点**
- 控制谁能下载
- 适合企业版 / 内部版 / 白名单分发

**缺点**
- 下载后代码仍在用户机器上
- 不能解决“已安装用户可逆向”的核心问题
- 不适合当前 public npm 产品定位的主线方案

**判断**
- **只能作为渠道策略，不是安全加固主方案**

---

## 推荐决策

## 推荐：**以 compile 方案为主线，服务端化高敏写路径为辅线**

### 为什么不是“直接全部服务端化”
因为当前 `aha-cli` 不是普通 Web 前端，而是：
- 本地 daemon
- 本地 session 管理
- 本地文件 / shell / tool orchestration
- 本地 MCP bridge

这些天然有大量“必须在本机执行”的部分。一次性全服务端化，代价太大。

### 为什么不是“只做混淆”
因为当前问题不是“用户能不能格式化代码”，而是：
- 架构机制完整可见
- 控制面协议可见
- token / publish 流程可见
- orchestration IP 可见

混淆不能解决这些结构性暴露。

### 所以推荐的现实路线是

### **Phase 1（近期决策）**：Compile 分发
把当前公开 npm 形态从“可读 JS 包”切到：
- **平台二进制**（编译产物）
- npm 包只做 launcher / downloader / updater

目标：先解决“用户安装 npm 包就能直接读懂核心 bundle”的问题。

### **Phase 2（中期硬化）**：把真正高敏的写路径继续收缩到服务端
优先收缩：
1. genome publish / promote / feedback 写操作
2. 需要 publish key 或受信代理的调用
3. 部分组织策略与监督规则的服务端计算

这样 compile 负责“提高逆向门槛”，服务端化负责“真正移除信任边界”。

---

## 实施步骤概述

## 阶段 0：边界切分（1–2 天）

目标：先把“必须本地”与“应该服务端”的代码切清楚。

### 必须本地保留
- daemon 生命周期管理
- 本地 shell / file / ripgrep / difftastic 能力
- 本地 MCP bridge
- 本地 UI / CLI 交互

### 应优先服务端化
- genome publish / promote / feedback 写入口
- 依赖 publish key 的 marketplace 写路径
- 某些 supervisor / org-manager 的高权限写操作
- 可能包含策略性组织 IP 的计算/决策面

## 阶段 1：compile spike（2–4 天）

做一个兼容性 spike：
- 比较 `pkg` 与 `bun compile` 哪个更能兼容当前项目
- 验证项：
  - 动态 import
  - fastify / MCP server
  - child_process spawn
  - tools/archives 解包与调用
  - native 依赖 / platform archive
  - codex bridge 子入口

**产出**：确定编译器选型，不在这个阶段追求全部上线。

## 阶段 2：npm wrapper 化（3–5 天）

把公开 npm 包改为：
- 安装时下载对应平台二进制，或
- `bin/aha.mjs` 仅作为薄启动器，调用本地缓存的已签名二进制

同时：
- 重新设计 `exports`
- 明确 `./lib` / `./codex/ahaMcpStdioBridge` 是否继续公开
- 若要保留 SDK 能力，拆成独立 package，不与主 CLI 同包发布

## 阶段 3：高敏链路服务端化（1–2 周）

优先级顺序：
1. genome marketplace 写路径
2. publish key 相关路径
3. 某些 supervisor / evolution 高权限路径
4. 组织策略中真正不希望完全公开的部分

---

## 工作量预估

| 阶段 | 人类团队 | CC+gstack |
|---|---:|---:|
| 边界切分与方案冻结 | 1–2 天 | 1–3 小时 |
| compile spike | 2–4 天 | 4–8 小时 |
| npm wrapper + 发布链改造 | 3–5 天 | 1 天 |
| 高敏写链服务端化 | 1–2 周 | 2–3 天 |

---

## 最终建议（给 Master / org-manager 的一句话版本）

**现在不要把时间花在 JS 混淆上。**

正确路线是：
1. **先把公开 npm 包切到 compile 分发**，快速去掉可读 JS bundle；
2. **再把 publish/promote/feedback 等真正高敏写路径继续服务端化**；
3. 私有 registry 只作为渠道补充，不作为主防线。

这条路线能同时满足：
- 短期止血（降低逆向可读性）
- 中期正确（真正收缩信任边界）
- 对现有本地 daemon / MCP / CLI 架构的破坏最小
