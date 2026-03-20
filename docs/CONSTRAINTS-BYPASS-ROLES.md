# Bypass Roles 信息传递约束

> **来源**: 参考最早的角色设计 (roles.ts:85 - `BYPASS_ROLES`)
> **目标**: 防止回声效应，优化信息传递
> **影响角色**: `supervisor`, `help-agent`

---

## 1. Bypass Roles 定义

```typescript
// roles.ts:85
export const BYPASS_ROLES = ['supervisor', 'help-agent'];
```

**核心原则**：
- Bypass roles **不参与**正常任务执行流程
- 只观察、评分、干预
- **最小化信息输出**，避免噪音

---

## 2. 信息传递约束

### 2.1 Supervisor 信息约束

#### ✅ 允许的信息类型

| 类型 | 触发条件 | 频率限制 | 格式 |
|------|----------|----------|------|
| **评分上报** | 每个 session 结束 | ≤1次/session | `score_agent` tool call |
| **危机干预** | 检测到 P0 问题 | 立即 | `send_team_message` type=`crisis` |
| **周期报告** | 每 6 小时 | ≤4次/天 | `send_team_message` type=`heartbeat` |
| **异常告警** | agent terminated/blocked >30min | 立即 | `request_help` |

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
    "responseLatency": "< 5min",
    "resolutionRate": "> 80%"
  }
}
```

---

## 6. 回声效应检测

**检测算法**：

```typescript
function detectEchoEffect(teamMessages: TeamMessage[]): boolean {
    const supervisorMessages = teamMessages.filter(
        m => m.role === 'supervisor' || m.role === 'help-agent'
    );

    // 规则 1: bypass roles 消息占比 < 20%
    if (supervisorMessages.length / teamMessages.length > 0.2) {
        return true;  // Echo effect detected
    }

    // 规则 2: supervisor 连续发送相同类型消息
    const recentMessages = supervisorMessages.slice(-5);
    const types = recentMessages.map(m => m.type);
    if (new Set(types).size < 3) {
        return true;  // Repetitive pattern
    }

    // 规则 3: 消息内容重复 > 30%
    const contents = recentMessages.map(m => m.content);
    const uniqueRatio = new Set(contents).size / contents.length;
    if (uniqueRatio < 0.7) {
        return true;  // Content echo
    }

    return false;
}
```

---

## 7. 历史教训

**问题**: Observer role added zero value, removed in v0.2
**根因**: 无约束的信息传递导致噪音
**解决**: 引入 BYPASS_ROLES + 信息约束

**问题**: Supervisor 回声效应 (2026-03-18)
**根因**: supervisor 发送大量状态更新
**解决**: 本文档的约束机制

---

## 8. 参考

- `roles.ts:85` - BYPASS_ROLES 定义
- `alwaysInjectedPolicies.ts:107` - isBypass 行为
- `ensureTeamMembership.ts:80` - specId 传递
- `PRE-LAUNCH-CHECKLIST.md` - SUP-2, EVO-1, SYS-4

---

**文档版本**: v1.0
**创建时间**: 2026-03-20
**作者**: @org-manager
**审批**: @master
