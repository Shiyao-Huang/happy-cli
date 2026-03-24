# Role Constraints & Information Flow Control

**目的**: 基于 BYPASS_ROLES 最早设计，对信息传递进行约束，防止回声效应，优化信息流

**状态**: ✅ Ready for Implementation  
**创建时间**: 2026-03-20  
**优先级**: P0

---

## 1. 背景

### 1.1 问题根因

| ID | 问题 | 影响 | 来源 |
|----|------|------|------|
| **SUP-1** | Supervisor 发送大量状态更新消息 | 噪音，回声效应 | PRE-LAUNCH-CHECKLIST |
| **SUP-2** | 评分未同步到 genome-hub | "大众点评"失效 | PRE-LAUNCH-CHECKLIST |
| **EVO-1** | ensureTeamMembership 不传 specId | Evolution 闭环断裂 | PRE-LAUNCH-CHECKLIST |
| **OBS-1** | Observer role removed in v0.2 | 无价值贡献 | roles.ts:77 |

### 1.2 最早的设计原则

**来源**: `roles.ts:85` - BYPASS_ROLES 定义

```typescript
// Bypass roles: operate outside the normal task workflow.
// They observe, score, and intervene but never execute implementation tasks.
export const BYPASS_ROLES = ['supervisor', 'help-agent'];
```

**核心原则**:
1. ✅ **静默观察** - 不发送状态更新
2. ✅ **评分干预** - 使用 `score_agent` 工具
3. ✅ **危机响应** - 只在 P0 问题时干预
4. ❌ **任务执行** - 永不执行实施任务

---

## 2. 信息传递约束

### 2.1 Supervisor 信息约束

#### ✅ 允许的信息类型

| 类型 | 触发条件 | 频率限制 | 格式 |
|------|----------|----------|------|
| **评分上报** | session 结束时 | 每次必调 | `score_agent` tool call |
| **危机告警** | P0 问题检测时 | 罕见 | `send_team_message` type=`crisis` |
| **心跳** | 每 6 小时 | 可选 | `send_team_message` type=`heartbeat` |
| **帮助请求** | 阻塞 >30min | 按需 | `request_help` tool call |

#### ❌ 禁止的信息类型

| 类型 | 原因 | 替代方案 |
|------|------|----------|
| **状态更新** | 非执行角色，无进度可报 | 静默监控 |
| **任务分配** | 越权行为 | 通知 `@master` 或 `@org-manager` |
| **普通讨论** | 增加噪音 | 静默观察 |
| **重复告警** | 回声效应 | 去重 + 合并报告 |

### 2.2 Help-Agent 信息约束

#### ✅ 允许的信息类型

| 类型 | 触发条件 | 频率限制 | 格式 |
|------|----------|----------|------|
| **帮助响应** | 收到 `@help` 提及 | 立即 | `send_team_message` type=`help-response` |
| **问题诊断** | 被请求帮助时 | 按需 | `send_team_message` type=`diagnosis` |
| **资源推荐** | 需要外部资源时 | 按需 | `send_team_message` type=`recommendation` |

#### ❌ 禁止的信息类型

| 类型 | 原因 | 替代方案 |
|------|------|----------|
| **主动干预** | 非紧急情况 | 等待 `@help` 请求 |
| **监控报告** | 与 supervisor 职责冲突 | 静默 |
| **投票参与** | 非执行角色，无投票权 | 静默 |

---

## 3. 实现机制

### 3.1 信息过滤逻辑

```typescript
// alwaysInjectedPolicies.ts 扩展
function buildBypassConstraints(role: 'supervisor' | 'help-agent'): string {
    if (role === 'supervisor') {
        return `
### Supervisor 信息约束 (BYPASS ROLE)

You are a **bypass role** operating outside normal task workflow.

**ALLOWED MESSAGES**:
- \`score_agent\` tool call when session ends (mandatory)
- Crisis alert when P0 issue detected (rare)
- Heartbeat every 6 hours (optional, silent otherwise)
- Help request when blocked >30min

**FORBIDDEN MESSAGES**:
- Task status updates (you don't execute tasks)
- Task assignments (that's @master or @org-manager's job)
- General discussions (silent observation mode)
- Duplicate alerts (deduplicate first, report once)

**KEY PRINCIPLE**: Silent watcher, minimal intervention, score everything.
`;
    }

    if (role === 'help-agent') {
        return `
### Help-Agent 信息约束 (BYPASS ROLE)

You are a **bypass role** providing on-demand help only.

**ALLOWED MESSAGES**:
- Help response when @mentioned (immediate)
- Diagnosis when help is requested (on-demand)
- Resource recommendations (on-demand)

**FORBIDDEN MESSAGES**:
- Proactive intervention (wait for @help)
- Monitoring reports (supervisor's job)
- Vote participation (non-executive role)

**KEY PRINCIPLE**: Reactive helper, never proactive, mention-only activation.
`;
    }

    return '';
}
```

### 3.2 回声效应消除

```typescript
// ensureTeamMembership.ts 修改
export async function ensureTeamMembership(opts: {
    // ... existing params
    specId?: string;  // ✅ 添加此字段
}): Promise<{ registered: boolean; alreadyPresent: boolean }> {
    const { specId } = opts;

    // ✅ 为 bypass roles 添加特殊处理
    const isBypass = BYPASS_ROLES.includes(role);

    await api.addTeamMember(
        teamId,
        sessionId,
        role,
        metadata.name || `${role}-agent`,
        {
            memberId: metadata.memberId,
            sessionTag: metadata.sessionTag,
            specId: specId || process.env.AHA_SPEC_ID || undefined,  // ✅ 确保 specId 被传递
            executionPlane: isBypass ? 'bypass' : metadata.executionPlane,  // ✅ 标记 execution plane
            runtimeType: metadata.flavor === 'codex' ? 'codex' : 'claude',
        }
    );
}
```

---

## 4. 验证清单

### 4.1 Supervisor 自检

- [ ] 每次评分后调用 `score_agent` (mandatory)
- [ ] 6小时内 team messages ≤ 5 条
- [ ] 危机消息 < 1% 的总消息量
- [ ] 无重复告警（去重逻辑存在）
- [ ] 无任务分配消息（越权）
- [ ] heartbeat 消息格式正确

### 4.2 Help-Agent 自检

- [ ] 只在 `@help` 提及后发送消息
- [ ] 无主动干预（非紧急）
- [ ] 无监控报告
- [ ] 无投票参与
- [ ] 诊断消息包含具体问题 + 解决方案

---

## 5. 监控指标

```json
{
  "supervisor": {
    "messagesPerHour": "< 1",
    "scoreUploadRate": "100%",
    "crisisAlertRate": "< 0.1/hour",
    "duplicateAlertRate": "0%"
  },
  "help-agent": {
    "proactiveMessageRate": "0%",
    "responseTime": "< 5min",
    "resolutionRate": "> 80%"
  }
}
```

---

## 6. 回声效应测试案例

### 测试场景

```typescript
// 场景 1: supervisor 检测到相同 P0 问题 3 次
// 期望：只发送 1 条危机告警（去重成功）

// 场景 2: supervisor 连续监控 6 小时
// 期望：≤ 5 条 team messages（大部分时间静默）

// 场景 3: help-agent 未被提及
// 期望：0 条消息（完全静默）

// 场景 4: help-agent 被 @help 提及
// 期望：立即响应（< 5 分钟）
```

---

## 7. 历史教训

**Observer Role (v0.2 之前)**:
- **问题**: 添加零价值贡献，纯噪音源
- **根因**: 无约束的信息传递
- **解决**: 移除角色 (roles.ts:77)
- **教训**: BYPASS roles 必须有严格的信息约束

**Supervisor 回声效应 (2026-03-18)**:
- **问题**: supervisor 发送大量重复状态更新
- **根因**: 缺乏信息过滤机制
- **解决**: 本文档的约束机制
- **教训**: 每条消息必须有明确的业务价值

---

## 8. 参考

- `roles.ts:85` - BYPASS_ROLES 定义
- `alwaysInjectedPolicies.ts:107` - isBypass 行为
- `ensureTeamMembership.ts:80` - specId 传递（需修复）
- `PRE-LAUNCH-CHECKLIST.md` - SUP-2, EVO-1 问题

---

**设计原则**: 信息最小化，效率优先
- 最小化信息传递，最大化评分效率

---

**创建时间**: 2026-03-20 08:50  
**作者**: @org-manager  
**版本**: v1.0  
**状态**: ✅ Ready for Review
