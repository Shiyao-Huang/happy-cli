# Team 交付隔离记录（本轮 Sprint）

> 这是一份**隔离记录**。  
> 下面列出的内容，都是通过 team 协作在本轮 Sprint 中完成的交付。  
> 由于这批交付对系统边界、运行方式和控制面的影响较大，先单独收录在本文件中，避免直接混入主说明正文。

---

## 1. 运行时与 workspace 物化

- 完成 `materializer v1`
  - `buildAgentWorkspacePlanFromGenome()`
  - `materializeAgentWorkspace()`
  - `settingsPath` 链路打通
  - `effectiveCwd` 接入
- 支持 `shared / isolated` 两种 workspace 模式
- 新增 `.genome/` overlay：
  - `spec.json`
  - `lineage.json`
  - `eval-criteria.md`
- 注入 `__genome_ref__`，让 agent 能知道自己的 genome 来源

---

## 2. runtime-lib 与资源物化策略

- 新增共享 runtime-lib 目录结构：
  - `runtime-lib/skills/`
  - `runtime-lib/mcp/`
  - `runtime-lib/prompts/`
  - `runtime-lib/hooks/`
  - `runtime-lib/tools/`
- 增加资源物化策略：
  - `linkSharedResource()`：共享只读资源 symlink
  - `copyPrivateResource()`：私有/可变资源 copy
  - `resolveMaterializationPolicy()`：决定 link / copy

---

## 3. Agent 启动与 Team 融合

- 新增 `aha agents spawn <file.agent.json>`
  - 本地读取并校验 `agent.json`
  - 物化 workspace
  - 通过 daemon spawn session
  - 可选自动注册进 team roster
- `runClaude.ts` 支持 `AHA_SETTINGS_PATH`
  - 可直接消费预物化的 `settings.json`
  - 允许 Docker / team 融合路径复用同一套物化结果

---

## 4. CLI 与控制面增强

- 新增 `aha sessions` CLI
  - `list`
  - `show`
  - `archive`
  - `delete`
- 新增 agent 模型切换控制面
  - CLI：`aha agents update --model --fallback-model`
  - MCP tool：`update_agent_model`
- `Metadata` 正式纳入：
  - `modelOverride`
  - `fallbackModelOverride`

---

## 5. Agent 模型自知

- 新增 `MODEL_CONTEXT_WINDOWS` 常量映射
- 在系统提示中注入：
  - 当前模型
  - fallback 模型
  - context window 大小
- `aha sessions show` 展示：
  - `resolvedModel`
  - `contextWindowTokens`

---

## 6. 测试与验证体系

- 完成 Docker / agent 测试金字塔的前四层：
  - L1：schema 校验
  - L2：materializer 产物校验
  - L3：hook / skill 机制验证
  - L4：agent liveness 静态合同与可选 E2E
- 已交付测试文件包括：
  - `materializer.test.ts`
  - `materializerIntegration.test.ts`
  - `dockerJsonCI.test.ts`
  - `agentMechanismE2E.test.ts`
  - `agentLivenessE2E.test.ts`
- 本轮 CI/机制层结果：
  - 相关测试通过
  - 需要 `ANTHROPIC_API_KEY` 的真实 AI E2E 在无 key 环境下按设计 skip

---

## 7. system agents / team 显示修复

- 修复 `System agents always zero`
- `list_team_agents` 现在会给旧成员补默认值：
  - `supervisor` / `help-agent` → `executionPlane: bypass`
  - `org-manager` 与其他角色 → `executionPlane: mainline`
  - `runtimeType` 默认回填为 `claude`

---

## 8. 文档与知识库

- 新增：
  - `docs/aha-v3-agent-guide.md`
  - `docs/aha-v3-cli-reference.md`
  - `skills/aha-v3-reference/SKILL.md`
- 这些文档描述了：
  - agent 角色与协作协议
  - CLI 命令总览
  - MCP / skill 使用速查

---

## 9. 本轮交付边界说明

这份隔离记录只总结**通过 team 协作完成**、且对运行时/控制面/工作区物化有明显影响的内容。

未并入本文件的内容：
- P2 架构设计项（例如 genome marketplace / evolution 的后续实现）
- 需要真实 API key 才能跑完的完整 AI E2E
- 未来可能继续变化的策略项

---

## 10. 当前结论

本轮已经把以下主链路打通：

`agent.json / genome → workspace 物化 → agent 启动 → team 注册 → CLI 控制 → 测试验证`

因此，这份隔离记录对应的是一批**已落地、但影响面较大**的基础设施交付。  
后续如果需要，可以再把其中稳定的部分回收进主文档正文。

