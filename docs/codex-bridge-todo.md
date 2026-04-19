# Codex Bridge TODO

## 已完成

- 将 Codex provider event 的基础归一化抽到独立 adapter：`src/codex/sessionEventAdapter.ts`
- 修复 `item_completed` 被无条件丢弃的问题，改为按内容去重
- 为 assistant / reasoning 去重补齐单测
- 新增 adapter 级 assistant replay reducer 与 identity 提取器，支持事件序列重放测试

## 进行中

- 用 replay 测试持续验证 `agent_message_delta -> agent_message -> item_completed`
- 将 turn / tool / subagent 身份判断从 `runCodex.ts` 继续收口到 adapter 层

## 下一步

1. 让 `runCodex.ts` 直接消费 adapter reducer，而不是保留本地的 assistant 去重/flush 分支
2. 为 tool / exec / patch / approval 事件补齐统一 identity 提取与回放测试
3. 明确 Codex subagent 字段来源，优先复用 `subagent | parent_call_id | parentCallId` 的映射策略
4. 评估是否需要把 identity 透传到上层消费者；如果需要，这会涉及 `kanban` / `happy-server` 的 schema 协同
5. 在有真实 transcript 的前提下，补一组更贴近线上日志的 fixture 回放测试

## 风险提醒

- 目前 identity 已在 adapter 层可提取，但尚未跨工作区透传到 UI schema
- `item_completed` 的 assistant / reasoning 路径已覆盖；非 assistant 类 `item_completed` 仍需继续观察
