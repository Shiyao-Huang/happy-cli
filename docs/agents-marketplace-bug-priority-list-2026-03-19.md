# `/agents` 验证问题优先级清单（2026-03-19）

来源：任务 `dnss3qBrZjPl`（进化分数 + 市场 + Docker + 用户旅程闭环）验证结果整理  
范围：`kanban` Web 端 `/agents`、`/agents/[id]` 以及相关 dev 路由/控制台信号  
结论：主流程已通过，但有 3 个应进入后续修复队列的问题

---

## 优先级总览

| 优先级 | 问题 | 当前判断 | 建议处理顺序 |
| --- | --- | --- | --- |
| P1 | `/agents` 页面状态显示互相矛盾 | 用户可见、影响信任 | 先修 |
| P2 | `dev/messages-demo-data.ts` 缺少 default export | dev 路由告警、污染控制台 | 第二批 |
| P2 | `dev/masked-progress` 路由声明存在但页面缺失；同时有多处 require cycle 告警 | dev 体验不完整、噪音较大 | 第二批 |

---

## 1) P1 — `/agents` 页面状态显示互相矛盾

### 现象
同一页面同时出现：

- `实时会话 2 个活跃`
- `在线智能体 0`
- `暂无活跃智能体`

这会让用户无法判断系统当前是否真的“有活跃 agent”。

### 复现步骤
1. 启动 `kanban` Web、本地 `happy-server`、`genome-hub`
2. 打开 `http://localhost:8081/agents`
3. 观察页面顶部 hero 区域与侧边状态区

### 期望
活跃会话、活跃智能体、状态区文案应基于同一份实时数据或同一口径计算，不应互相冲突。

### 实际
hero 区域显示有 2 个活跃会话，但状态区仍显示 0 个在线智能体、且为空态文案。

### 影响
- 直接影响用户对系统状态的信任
- 会误导后续的市场/团队/agent 使用判断
- 属于用户可见问题，应优先于纯 dev 告警修复

### 证据
页面文本实测同时包含：

```text
实时会话 2 个活跃
在线智能体 0
暂无活跃智能体
```

### 建议检查文件
- `kanban/sources/app/(app)/agents/index.tsx`
- `kanban/sources/components/layout/FloatingIslandSidebar.tsx`
- `kanban/sources/components/layout/HomeMainPanel.tsx`
- `kanban/sources/app/(app)/index.tsx`

### 修复后验收
- `/agents` 页面不再同时出现“有活跃会话”和“无活跃智能体”的冲突状态
- 当存在活跃会话/agent 时，状态区与 hero 区口径一致
- 空态文案只在真实空态时出现

---

## 2) P2 — `dev/messages-demo-data.ts` 缺少 default export

### 现象
浏览器控制台出现：

```text
Route "./(app)/dev/messages-demo-data.ts" is missing the required default export. Ensure a React component is exported as default.
```

### 复现步骤
1. 打开 `http://localhost:8081/agents`
2. 打开浏览器控制台
3. 等待页面加载完成

### 期望
`app/(app)/dev/*` 下被 Expo Router 识别为路由的文件，应导出默认 React 组件；如果只是数据文件，不应放在路由目录里被扫描成页面。

### 实际
`kanban/sources/app/(app)/dev/messages-demo-data.ts` 是 demo 数据文件，但放在路由目录内，被框架当作页面处理并报警。

### 影响
- dev 控制台噪音增加
- 容易掩盖更重要的真实错误
- 说明 dev 路由边界不够干净

### 建议检查文件
- `kanban/sources/app/(app)/dev/messages-demo-data.ts`
- `kanban/sources/app/(app)/dev/messages-demo.tsx`

### 建议修复方向
- 方案 A：把 demo 数据移出路由目录
- 方案 B：如果必须保留在目录内，则改为真正的页面模块结构

### 修复后验收
- 控制台不再出现 missing default export 告警
- `messages-demo` 页面仍可正常引用 demo 数据

---

## 3) P2 — `dev/masked-progress` 路由缺失；同时存在多处 require cycle 告警

### 现象 A：缺失路由
控制台出现：

```text
[Layout children]: No route named "dev/masked-progress" exists in nested children
```

同时，`kanban/sources/app/(app)/_layout.tsx` 里仍显式声明了：

```tsx
<Stack.Screen
    name="dev/masked-progress"
    options={{ headerTitle: 'Masked Progress' }}
/>
```

### 现象 B：require cycle 告警
控制台还出现多条循环依赖告警，例如：

```text
sources/modal/index.ts -> sources/modal/ModalProvider.tsx -> ...
sources/auth/AuthContext.tsx -> sources/sync/sync.ts -> sources/sync/apiSocket.ts -> ...
sources/sync/sync.ts -> sources/sync/storage.ts -> sources/sync/sync.ts
```

### 复现步骤
1. 打开 `http://localhost:8081/agents`
2. 打开浏览器控制台
3. 等待初始 bundle 与页面加载完成

### 期望
- `_layout.tsx` 中声明的 dev 路由应真实存在
- 控制台应尽量只保留高价值信号，而不是长期堆积结构性告警

### 实际
- layout 声明了不存在的路由
- 同时存在多条 require cycle 告警

### 影响
- dev 路由完整性受损
- 控制台信号质量下降
- 后续排查真实问题时容易被噪音淹没

### 建议检查文件
- `kanban/sources/app/(app)/_layout.tsx`
- `kanban/sources/app/(app)/dev/` 目录
- `kanban/sources/modal/*`
- `kanban/sources/auth/*`
- `kanban/sources/sync/*`
- `kanban/sources/components/tools/*`

### 修复建议
- 先解决 `dev/masked-progress`：要么补回页面，要么删掉 `_layout.tsx` 中的声明
- require cycle 作为后续结构治理项，按模块簇拆解，不建议一次性大重构

### 修复后验收
- 控制台不再出现 `dev/masked-progress` 缺失告警
- require cycle 告警数量至少下降，且关键链路（auth/sync/modal）有明确治理计划

---

## 推荐执行顺序

1. **先修 P1：`/agents` 状态口径冲突**
   - 这是用户可见问题
   - 直接影响“市场/agent 是否在线”的认知

2. **再修 P2：两个 dev / console 问题**
   - `messages-demo-data.ts` default export 告警
   - `dev/masked-progress` 缺失声明

3. **最后处理结构性 require cycle**
   - 作为持续迭代项拆分处理
   - 不建议在当前验证批次内顺手大改

---

## 一句话总结

`/agents` 主流程能用，但当前最该优先修的是“状态口径不一致”；其余两个问题属于 dev 信号与路由完整性治理，应排在第二优先级。
