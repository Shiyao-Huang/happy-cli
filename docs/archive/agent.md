## 2026-04-20 architect 巡检登记

### 已确认问题

1. **Codex runtime 会话命名与 Claude runtime 不一致**
   - 位置：
     - `src/codex/runCodex.ts`
     - 对照：`src/claude/runClaude.ts`
   - 现象：
     - Claude 优先使用 `AHA_SESSION_NAME`，再回退 `AHA_ROOM_NAME`
     - Codex 只读取 `AHA_ROOM_NAME`
   - 风险：
     - 团队成员展示名可能退化为房间名/代号
     - 与消息层、团队注册层把 `metadata.name` 当权威展示名的契约不一致

### 首轮迭代计划

- 抽出 Codex runtime 的会话命名解析函数
- 对齐 Claude 的优先级：`AHA_SESSION_NAME > AHA_ROOM_NAME`
- 补充目标测试，验证显式 session name 优先且 roomName 仍保留

## 2026-04-20 implementer 巡检登记

### 已确认问题

1. **CLI Email OTP 仍在源码中硬编码 Supabase URL / anon key**
   - 位置：
     - `src/api/supabaseAuth.ts:8-9`
   - 现象：
     - `SUPABASE_URL` / `SUPABASE_ANON_KEY` 在 env 缺失时静默回退到真实默认值
   - 风险：
     - 与 kanban 已修复的 fail-fast 配置边界不一致
     - 开发/测试环境可能误连真实 Supabase 项目
     - 真实 anon key 不应继续留在源码默认值中

### 首轮处理方案

- 移除硬编码默认值，改为强制读取 `SUPABASE_URL` / `SUPABASE_ANON_KEY`
- 缺失或非法时抛出明确错误，避免静默回退
- 补充目标测试，覆盖缺失/空白/非法 key 与显式 env 成功分支
- 受当前团队“暂停一切编译/测试命令”规则影响，本轮先提交代码修复与测试文件，验证等待资源恢复后执行

## 2026-04-20 architect 任务登记（#P-001）

### 已确认问题

1. **团队缺少统一的重操作资源感知与准入控制**
   - 位置：
     - `src/daemon/hostHealth.ts`
     - `src/claude/mcp/supervisorTools.ts`（`tsc_check`）
     - `src/daemon/sessionManager.ts`
   - 现象：
     - 仓库里已经零散存在 host health、`tsc_check` 内存检查/独占锁、spawn 并发限制
     - 但这些能力没有收敛成统一的“重操作预算/锁/提示”机制
     - 普通 build / test / exec_command 仍可能被多个 agent 并发触发，导致整机卡死
   - 风险：
     - 3-5 个 agent 并发 build / typecheck / 全量测试时，内存和 CPU 会被瞬间打满
     - agent 在决策前看不到统一资源状态，也没有强制的重操作 slot

### 本轮产出

- 输出技术方案文档：`docs/resource-aware-heavy-ops-design-2026-04-20.md`
- 方案目标：把已有零散能力收敛成 `ResourceGovernor + get_resource_status + heavy-op lease`

### 继续落地（#RA-003）

- 已在 `src/claude/mcp/supervisorTools.ts` 注册 `get_host_health`
- 已在 `src/claude/mcp/index.ts` 将其加入 MCP tool 列表
- observer 提醒的重复项已复核：当前仅保留一处 `get_host_health` 注册与一处 toolNames 条目
- 本轮未运行任何 build / tsc / vitest / yarn；待内存恢复后再做验证
