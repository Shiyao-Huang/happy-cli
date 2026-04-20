# Stream E UX / 稳定性验证（2026-03-19）

任务：`Stream E UX/稳定性验证（bb-browser）`

验证方式：
- 使用 `gstack /browse` 本地启动 `kanban` Web（`http://127.0.0.1:19006`）
- 逐页检查关键 Stream E 路径
- 记录页面文本、控制台告警、截图证据

证据目录：`aha-cli/docs/evidence/stream-e-ux-stability-2026-03-19/`

---

## 1. Checklist

### E-01 首页 / Session Control 着陆页
- ✅ 通过
- 路径：`/`
- 结果：着陆页正常显示 `Aha Session Control`、加密说明、`Create account`、Session 控制卡片。
- 证据：`01-root-landing.png`

### E-02 `/agents` Marketplace 页面
- ✅ 通过
- 路径：`/agents`
- 结果：页面可正常打开，左侧状态栏、Marketplace tab、Agents/Corps tab、筛选 chip 和 empty state 正常显示。
- 证据：`02-agents-marketplace.png`

### E-03 `/agents/new` 新建智能体页面
- ✅ 通过
- 路径：`/agents/new`
- 结果：页面正常加载；`Agent Name` 输入框、`Claude Code / Codex` 运行时选择、`Create` 按钮均可见。
- 证据：`03-agents-new.png`

### E-04 `/settings/usage` 使用量页面未登录兜底
- ✅ 通过
- 路径：`/settings/usage`
- 结果：在未登录状态下明确显示 `Not authenticated`，没有白屏或 crash。
- 证据：`04-settings-usage.png`

### E-05 `/teams/new` 创建团队页面
- ✅ 通过
- 路径：`/teams/new`
- 结果：页面正常加载；可见 `Create Team`、`Manual / Prompt`、角色配比、`Claude / Codex` provider 选择、machine/working directory 提示。
- 证据：`05-teams-new.png`

### E-06 `/session/recent` 最近会话页面
- ✅ 通过
- 路径：`/session/recent`
- 结果：页面正常加载；在无数据时明确显示 `No sessions found`，没有白屏或报错弹窗。
- 证据：`06-session-recent.png`

### E-07 `/terminal/connect` 无参数兜底
- ✅ 通过
- 路径：`/terminal/connect`
- 结果：无连接参数时明确显示 `Invalid Connection Link`，兜底文案正常。
- 证据：`07-terminal-connect-invalid-link.png`

### E-08 状态信号栏基本渲染
- ✅ 通过
- 观察页：`/agents`、`/agents/new`、`/teams/new`
- 结果：左栏 `Needs Decision / Working / Online` 三种状态信号可见；布局稳定，无重叠。
- 证据：`02-agents-marketplace.png`、`03-agents-new.png`、`05-teams-new.png`

### E-09 之前记录的 dev 路由告警复测
- ✅ 本轮未复现
- 检查项：
  - `dev/messages-demo-data.ts` 缺少 default export
  - `dev/masked-progress` 路由不存在
- 结果：本轮在 `19006` 本地 web 复测 `/agents` 时，控制台未出现上述两条告警。
- 证据：`08-console-agents.txt`

---

## 2. Bug list

### B-01 控制台存在大量 require cycle 告警
- 严重级别：⚠️ P2
- 现象：多个页面持续出现 `Require cycle` 告警，涉及：
  - `sources/modal/*`
  - `sources/auth/AuthContext.tsx`
  - `sources/sync/*`
  - `sources/components/tools/views/*`
- 影响：不一定阻塞主流程，但会降低调试信号质量，也可能引出初始化顺序问题。
- 证据：`08-console-agents.txt`

### B-02 Web 控制台存在过时 API / 样式告警
- 严重级别：⚠️ P3
- 现象：反复出现：
  - `"shadow*" style props are deprecated. Use "boxShadow".`
  - `props.pointerEvents is deprecated. Use style.pointerEvents`
- 影响：当前不阻塞使用，但属于应尽快清理的技术债。
- 证据：`08-console-agents.txt`

### B-03 Expo notifications Web 能力提示持续出现
- 严重级别：ℹ️ P3
- 现象：`[expo-notifications] Listening to push token changes is not yet fully supported on web.`
- 影响：说明当前 Web 端 push token 监听能力有限；如果后续把该能力当成 Web 主路径，需单独兜底。
- 证据：`08-console-agents.txt`

---

## 3. 结论

本轮 Stream E 的 **关键可见 UX 路径** 均可打开，未出现白屏、崩溃、无法路由到页面等 P0/P1 问题：

- 首页着陆页
- Agents 列表页
- 新建 Agent 页
- 新建 Team 页
- Recent Sessions 页
- Terminal Connect 无效链接兜底页
- Settings Usage 未登录兜底页

同时，本轮对先前记录的两条 dev 路由告警进行了复测，**在当前本地 Web 环境中未复现**。

当前更值得持续跟进的是 **控制台噪音类问题**：大量 require cycle 与过时 API/样式告警。这些更偏向稳定性/可维护性债务，而不是当前阻塞用户主流程的功能缺陷。
