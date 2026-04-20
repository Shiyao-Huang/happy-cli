# Phase-4 决策：Claude Code / Codex 双 Runtime 桥接模型（2026-04-21）

## 结论（已锁定）

采用 **MCP-first** 作为 SDK 统一桥接层；Skill/Script/Bash 作为上层编排与运维入口，不作为底层传输层替代。

---

## 为什么是 MCP-first

1. **Claude 与 Codex 都可消费 MCP server**
   - Claude runtime：HTTP MCP
   - Codex runtime：stdio bridge → 同一个 Aha MCP server

2. **现有 Mozart shim/adapter 已落在 MCP registerTool 路径**
   - `src/claude/mcp/index.ts`
   - `src/claude/mcp/mozartShim.ts`
   - `src/claude/mcp/mozartHttpAdapter.ts`

3. **统一语义与观测**
   - 同一处实现 feature flag / fallback / structured logging
   - 避免 Claude/Codex 两套“各自修补”逻辑漂移

---

## Skill / Script / Bash 的角色定位

- **Skill**：人机交互入口（任务模板、工作流引导）
- **Script/Bash**：运维与调试入口（本地冒烟、回归脚本）
- **MCP**：真正的运行时调用平面（工具调用、错误语义、回滚）

> 换言之：Skill 和 Script 负责“怎么触发”，MCP 负责“怎么执行”。

---

## 当前实现状态（本分支）

1. **统一桥接配置已存在并生效**
   - `src/runtime/mcpBridgeConfig.ts`
   - `src/claude/runClaude.ts`
   - `src/codex/runCodex.ts`

2. **daemon 已支持 Mozart sidecar 生命周期**
   - `src/daemon/mozartSidecar.ts`
   - `src/daemon/run.ts`

3. **Rust sidecar + TS adapter + fallback 已验证**
   - Phase-1/2/3 测试与 golden-diff 证据已落盘在 `mozart/qa/`

---

## Phase-4 执行约束

1. 新增桥接能力时，优先改 MCP 层（而非先改 Skill）
2. Skill 只封装工作流，不复制工具调用语义
3. Bash 脚本仅用于验证与排障，不写业务语义分支
4. Claude/Codex 行为差异必须通过统一测试基线收敛（同一组用例）

---

## 验收标准（继续沿用）

1. Claude 路径与 Codex 路径同一工具集、同一错误语义
2. `MOZART_ENABLED=0` 零行为变更
3. `MOZART_ENABLED=1` 失败可回退
4. Golden-diff 工具集一致（direct vs mozart）
5. 关键回滚场景（500/timeout/schema-mismatch）持续全绿

