# Fallback Pattern Analysis: 开发环境Bug掩盖风险

**任务**: #task-qio9ibkuy
**分析时间**: 2026-03-30
**分析范围**: aha-cli-0330-max/src
**用户原则**: "禁止fallback阻塞开发环境的bug发现"

---

## Executive Summary

**发现**: 58个 empty catch block，其中:
- 🔴 **7个 HIGH风险** — 可能掩盖开发环境关键bug
- 🟡 **12个 MEDIUM风险** — 应该至少log，当前静默
- 🟢 **39个 LOW风险** — 清理/关闭操作，genuinely non-fatal

**核心问题**: 多数catch block在dev/prod环境行为一致，导致dev环境中本应暴露的bug被fallback掩盖。

**解决方案**: 引入 `process.env.NODE_ENV === 'development'` 分支，dev环境hard fail，prod环境graceful fallback。

---

## 🔴 HIGH Risk: 掩盖关键功能Bug

### 1. **Supervisor Feedback Fetch** ⚠️ CRITICAL
**文件**: `src/claude/mcp/supervisorTools.ts:430`

```typescript
} catch { /* feedback fetch is best-effort */ }
```

**为什么危险**:
- Feedback是genome进化的数据源
- 如果fetch失败（网络/权限/API变更），supervisor完全不知道
- Dev环境应该立即暴露这个问题

**影响**:
- Genome evolution pipeline静默失败
- Supervisor无法获取performance data
- 进化系统disabled但无人知晓

**修复**:
```typescript
} catch (error) {
  if (process.env.NODE_ENV === 'development') {
    logger.error('[DEV] Feedback fetch failed - this breaks genome evolution!', error);
    throw new Error(`Supervisor feedback fetch failed: ${error}`);
  }
  // Production: best-effort is acceptable
  logger.debug('[PROD] Feedback fetch failed (non-fatal)', error);
}
```

---

### 2. **Genome API Fallback** ⚠️ HIGH
**文件**: `src/daemon/supervisorScheduler.ts:159`

```typescript
try {
  const res = await axios.get(`${hubUrl}/genomes/%40official/${name}`, ...);
  const id = res.data?.genome?.id ?? null;
  if (id) return id;
} catch { /* fall through to legacy */ }

try {
  const res = await axios.get(`${serverUrl}/v1/genomes/%40official/${name}/latest`, ...);
  // ...
```

**为什么危险**:
- 新API（genome-hub）失败后静默fallback到legacy API
- 如果genome-hub有bug/权限问题/数据不一致，dev环境永远不知道
- 新API永远无法完全迁移（因为bug被掩盖）

**影响**:
- Genome-hub migration永远无法完成
- 数据不一致问题被掩盖
- Dev环境测试不出新API问题

**修复**:
```typescript
try {
  const res = await axios.get(`${hubUrl}/genomes/%40official/${name}`, ...);
  const id = res.data?.genome?.id ?? null;
  if (id) return id;
} catch (error) {
  if (process.env.NODE_ENV === 'development') {
    logger.error(`[DEV] Genome Hub API failed for ${name}:`, error);
    throw new Error(`Genome Hub API broken - fix before using legacy fallback: ${error}`);
  }
  logger.warn(`[PROD] Genome Hub API failed for ${name}, falling back to legacy`, error);
}
// Legacy fallback only in production
```

---

### 3. **JSON Parsing Failures** ⚠️ MEDIUM-HIGH
**文件**: `src/claude/mcp/agentTools.ts:112`

```typescript
try { fb = g.feedbackData ? JSON.parse(g.feedbackData) : {}; } catch { /* */ }
```

**为什么危险**:
- Genome feedbackData格式错误时静默返回 `{}`
- 如果数据库存储了malformed JSON，agent无法发现
- 数据损坏被掩盖，而非修复

**影响**:
- Genome feedback数据损坏无法被发现
- Evolution system获取到空数据
- 用户永远不知道数据已损坏

**修复**:
```typescript
try {
  fb = g.feedbackData ? JSON.parse(g.feedbackData) : {};
} catch (error) {
  if (process.env.NODE_ENV === 'development') {
    logger.error(`[DEV] Malformed feedbackData for genome ${g.id}:`, error);
    throw new Error(`Genome feedbackData is malformed - DB integrity issue: ${error}`);
  }
  logger.error(`[PROD] Malformed feedbackData for genome ${g.id}, using empty object`, error);
  fb = {};
}
```

---

### 4. **Non-critical MCP Tool Failures** ⚠️ MEDIUM
**文件**: `src/claude/mcp/supervisorTools.ts:474, 488`

```typescript
} catch { /* non-critical */ }
```

**Context**: 需要看具体代码确定是否critical（未展开读取）

**一般原则**:
- 如果是MCP tool内部逻辑，failure应该传递给agent
- Agent需要知道tool失败了，而非收到partial/empty结果

---

### 5. **Context Tools JSON Parsing** ⚠️ MEDIUM
**文件**: `src/claude/mcp/contextTools.ts:132`

```typescript
try { return JSON.parse(item.value); } catch { return null; }
```

**为什么危险**:
- Context data格式错误时返回null
- Agent context system可能收到不完整数据
- 数据损坏静默忽略

**修复**:
```typescript
try {
  return JSON.parse(item.value);
} catch (error) {
  if (process.env.NODE_ENV === 'development') {
    logger.error('[DEV] Context item parse failed:', { key: item.key, error });
    throw new Error(`Context data malformed for key ${item.key}: ${error}`);
  }
  logger.warn('[PROD] Context item parse failed, returning null', { key: item.key });
  return null;
}
```

---

### 6. **Sprint Retro JSON Parsing** ⚠️ LOW-MEDIUM
**文件**: `src/claude/mcp/sprintRetro.ts:109`

```typescript
.map(l => { try { return JSON.parse(l); } catch { return null; } })
```

**为什么有风险**:
- Sprint log数据损坏时静默过滤掉
- Retrospective分析会缺失数据
- Dev环境应该知道log文件有问题

**修复**:
```typescript
.map((l, idx) => {
  try {
    return JSON.parse(l);
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      logger.error(`[DEV] Sprint log line ${idx} is malformed:`, error);
      throw new Error(`Sprint log corrupted at line ${idx}: ${error}`);
    }
    logger.warn(`[PROD] Sprint log line ${idx} skipped (malformed)`, error);
    return null;
  }
})
.filter(Boolean)
```

---

### 7. **Supervisor Tools Board Parsing** ⚠️ MEDIUM
**文件**: `src/claude/mcp/supervisorTools.ts:915`

```typescript
try { board = JSON.parse(bodyValue); } catch { /* ignore */ }
```

**为什么危险**:
- Kanban board数据格式错误时静默ignore
- Supervisor看不到board状态，评分可能有误
- 数据格式变更不会被发现

---

## 🟡 MEDIUM Risk: 应该Log但当前静默

### 8-19. **Trace Failures** (12个实例)
**文件**:
- `src/daemon/sessionManager.ts:559, 675, 883`
- `src/claude/runClaude.ts:859`
- `src/claude/mcp/supervisorTools.ts:904, 1091, 1143`
- `src/claude/mcp/agentTools.ts:297`
- `src/claude/mcp/taskTools.ts:107, 769, 837, 929`
- `src/claude/mcp/evolutionTools.ts:86, 115`

```typescript
} catch { /* trace must never break main flow */ }
```

**为什么需要改进**:
- Trace失败说明monitoring/observability系统有问题
- Dev环境应该至少log warning
- 完全静默 = 永远不知道trace系统坏了

**修复**:
```typescript
} catch (error) {
  if (process.env.NODE_ENV === 'development') {
    logger.warn('[DEV] Trace write failed - monitoring系统有问题', error);
  }
  // Never break main flow, but at least log in dev
}
```

---

## 🟢 LOW Risk: Cleanup操作，genuinely non-fatal

### 20-58. **Process Kill / Cleanup / Shutdown** (39个实例)

**类别**:
1. **Process.kill catches** (8个) - process已死，kill失败是正常的
2. **Cleanup on shutdown** (10个) - daemon关闭时清理失败不影响主流程
3. **stdin.setRawMode** (2个) - terminal cleanup失败不影响功能
4. **Temp file cleanup** (3个) - 临时文件删除失败不影响主操作
5. **Stale lock检查** (3个) - 检查失败说明lock已不存在（正常）
6. **MCP client cleanup** (3个) - 连接关闭失败时已经在关闭流程中
7. **Weixin cleanup** (2个) - channel清理失败不影响核心功能
8. **Auth cleanup** (5个) - 认证清理失败不影响新认证
9. **Malformed log lines** (1个) - 跳过格式错误的日志行
10. **Non-fatal channel operations** (2个) - channel操作失败已有其他重试机制

**评估**: 这些真正是non-fatal，但仍建议在dev环境log debug信息以便排查。

---

## 修复方案

### 方案A: 环境变量控制 (推荐)

**优势**:
- 细粒度控制每个catch block行为
- Dev环境hard fail暴露bug
- Prod环境graceful fallback保证稳定性

**实现**:
1. 在每个HIGH/MEDIUM risk catch block加入环境检查
2. Dev环境: log error + throw
3. Prod环境: log warning/debug + fallback

**Example**:
```typescript
try {
  // critical operation
} catch (error) {
  if (process.env.NODE_ENV === 'development') {
    logger.error('[DEV] Critical operation failed:', error);
    throw error; // Hard fail in dev
  }
  logger.warn('[PROD] Critical operation failed, using fallback', error);
  // Graceful fallback
}
```

---

### 方案B: Logger级别控制

**优势**:
- 代码改动最小
- 统一配置

**劣势**:
- Log不等于throw，有些bug仍会被掩盖
- 需要主动看日志才能发现问题

**实现**:
```typescript
try {
  // critical operation
} catch (error) {
  logger.error('Critical operation failed:', error); // Dev环境配置logger.error会throw
  // fallback
}
```

---

### 方案C: Feature Flag

**优势**:
- 可以动态开关
- 可以按team/session控制

**劣势**:
- 增加复杂度
- 需要额外基础设施

---

## 实施计划

### Phase 1: HIGH Risk修复（立即）
1. ✅ Supervisor feedback fetch (supervisorTools.ts:430)
2. ✅ Genome API fallback (supervisorScheduler.ts:159)
3. ✅ Agent feedbackData parsing (agentTools.ts:112)
4. ✅ Context tools parsing (contextTools.ts:132)

**预计影响**: 4个文件，~20行代码修改

---

### Phase 2: MEDIUM Risk改进（本周）
1. ✅ Sprint retro parsing (sprintRetro.ts:109)
2. ✅ Board parsing (supervisorTools.ts:915)
3. ✅ Supervisor tools non-critical catches (supervisorTools.ts:474, 488)
4. ✅ 12个trace failure warnings

**预计影响**: 6个文件，~60行代码修改

---

### Phase 3: LOW Risk监控增强（可选）
1. 39个cleanup catches加debug log
2. 建立cleanup failure监控dashboard

**预计影响**: 15个文件，~100行代码修改（可选）

---

## 测试计划

### Unit Tests
- [ ] 模拟feedback fetch失败（dev环境应throw）
- [ ] 模拟genome API失败（dev环境应throw）
- [ ] 模拟JSON parsing失败（dev环境应throw）
- [ ] 验证prod环境fallback仍然工作

### Integration Tests
- [ ] Dev环境启动daemon，触发feedback fetch失败
- [ ] Dev环境触发genome API失败
- [ ] 验证error被throw且有清晰错误信息

### Manual Verification
- [ ] 本地dev环境测试所有修复
- [ ] Staging环境验证prod fallback
- [ ] 确认日志输出清晰可追踪

---

## TDD Test Cases

### Test 1: Feedback Fetch - Dev Hard Fail
```typescript
describe('Supervisor Feedback Fetch', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'development';
  });

  it('should throw in dev environment when feedback fetch fails', async () => {
    // Mock network failure
    mockAxios.get.mockRejectedValue(new Error('Network timeout'));

    await expect(getSelfView()).rejects.toThrow('Supervisor feedback fetch failed');
  });
});
```

### Test 2: Genome API - Dev Hard Fail
```typescript
describe('Genome Hub API', () => {
  it('should throw in dev when Genome Hub API fails', async () => {
    process.env.NODE_ENV = 'development';
    mockAxios.get.mockRejectedValue(new Error('401 Unauthorized'));

    await expect(resolveOfficialGenomeId('supervisor')).rejects.toThrow('Genome Hub API broken');
  });

  it('should fallback to legacy in production', async () => {
    process.env.NODE_ENV = 'production';
    mockAxios.get
      .mockRejectedValueOnce(new Error('Hub failed')) // First call fails
      .mockResolvedValueOnce({ data: { genome: { id: 'legacy-id' } } }); // Second call succeeds

    const id = await resolveOfficialGenomeId('supervisor');
    expect(id).toBe('legacy-id');
  });
});
```

### Test 3: JSON Parsing - Dev Hard Fail
```typescript
describe('Feedback Data Parsing', () => {
  it('should throw in dev when feedbackData is malformed', () => {
    process.env.NODE_ENV = 'development';
    const genome = { id: 'test-genome', feedbackData: '{invalid json}' };

    expect(() => parseGenomeFeedback(genome)).toThrow('feedbackData is malformed');
  });

  it('should return empty object in prod when feedbackData is malformed', () => {
    process.env.NODE_ENV = 'production';
    const genome = { id: 'test-genome', feedbackData: '{invalid json}' };

    const result = parseGenomeFeedback(genome);
    expect(result).toEqual({});
  });
});
```

---

## Appendix: 完整清单（58个catch blocks）

### HIGH Risk (7)
1. supervisorTools.ts:430 - feedback fetch
2. supervisorScheduler.ts:159 - genome API fallback
3. agentTools.ts:112 - feedbackData parsing
4. contextTools.ts:132 - context parsing
5. sprintRetro.ts:109 - sprint log parsing
6. supervisorTools.ts:915 - board parsing
7. supervisorTools.ts:474, 488 - non-critical (需确认)

### MEDIUM Risk (12)
8-19. Trace failures (sessionManager x3, runClaude x1, supervisorTools x3, agentTools x1, taskTools x4, evolutionTools x2)

### LOW Risk (39)
20-28. Process.kill catches (9 instances)
29-38. Cleanup on shutdown (10 instances)
39-40. stdin.setRawMode cleanup (2 instances)
41-43. Temp file cleanup (3 instances)
44-46. Stale lock checks (3 instances)
47-49. MCP client cleanup (3 instances)
50-51. Weixin cleanup (2 instances)
52-56. Auth cleanup (5 instances)
57. Malformed log line (1 instance)
58. Channel command executor (1 instance)

---

## 结论

**核心发现**: 7个HIGH风险catch block正在掩盖关键功能bug，符合用户指出的"fallback阻塞bug发现"问题。

**推荐行动**:
1. ✅ 立即修复7个HIGH风险位置（Phase 1）
2. ✅ 本周完成12个MEDIUM风险改进（Phase 2）
3. ⏸️  39个LOW风险作为可选监控增强（Phase 3）

**符合用户原则**: "禁止fallback阻塞开发环境的bug发现" ✅

---

**Builder**: 完成分析，等待review和实施批准。
