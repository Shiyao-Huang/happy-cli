# Agent Package v1 Design

Date: 2026-04-03
Status: Accepted

## 1. Decision

固定采用以下三层模型：

1. `Base Image`
   Docker / OCI image，只负责运行环境、CLI、模型适配器、系统依赖。
2. `Agent Package`
   Aha 自己的轻量打包格式，只负责 agent 的定义、知识、权限、挂载声明、文件清单。
3. `Runtime Workspace`
   启动时 materialize 出来的本地工作区，只是运行时副本，不是真相源。

这意味着：

- 不再把 agent 等价为“一个本地目录”
- 不再把 runtime 生成物当作主编辑面
- 不再依赖“胖 spec JSON + files KV”作为长期终态

## 2. Why

当前模型的问题不是“files 不生效”，而是职责混杂：

- Docker image 负责运行时
- `spec` 负责 agent 定义
- `files` 又把知识文件、skill、docs 塞进同一个 JSON
- materialized `.claude/settings.json`、env、mcp config 又成了容易被误编辑的派生物

这会导致：

- 传输过重：一个小文件变化也会导致整份 `spec` 重传
- diff 失真：generated files、真实意图、知识文件混在一起
- 权限边界差：agent 容易直接改 runtime 派生文件
- 可移植性脆弱：`skills` 只是名字，不是内容

## 3. Core Rule

唯一真相源不是本地文件系统，而是 `Agent Package`。

进一步拆开：

- `Base Image` 是执行底座，不是 agent 身份
- `Agent Package` 是 agent 身份与能力定义
- `Runtime Workspace` 是可丢弃的 materialized view

因此：

- agent 可读写本地 workspace
- 但回写必须通过 package diff / patch
- generated runtime files 永远不作为主编辑对象

## 4. Package Shape

`Agent Package` 不是新的容器格式，而是挂在 OCI image 之上的 agent 包格式。

最小 schema：

```json
{
  "kind": "aha.agent.package.v1",
  "baseImage": "ghcr.io/aha/agent-base:2026-04-03",
  "entrypoint": "claude",
  "manifest": {
    "identity": {
      "namespace": "@official",
      "name": "builder",
      "version": 12
    },
    "runtime": {
      "type": "claude",
      "executionPlane": "mainline",
      "permissionMode": "default",
      "accessLevel": "full-access"
    },
    "permissions": {
      "allowedTools": ["read_cc_log", "request_help"],
      "disallowedTools": ["replace_agent"]
    },
    "behavior": {
      "onIdle": "wait",
      "onBlocked": "report",
      "canSpawnAgents": true
    },
    "messaging": {
      "listenFrom": "*",
      "receiveUserMessages": false,
      "replyMode": "passive"
    },
    "mounts": [
      {
        "name": "project",
        "source": "repo",
        "target": "/workspace/project",
        "mode": "rw"
      }
    ]
  },
  "files": {
    "prompts/system.md": {
      "hash": "sha256:...",
      "size": 1234,
      "requiredAtSpawn": true
    },
    "skills/context-hygiene/SKILL.md": {
      "hash": "sha256:...",
      "size": 456,
      "requiredAtSpawn": true
    },
    "docs/system-mirror/how-agents-work.md": {
      "hash": "sha256:...",
      "size": 2048,
      "requiredAtSpawn": false
    }
  }
}
```

## 5. Contained vs Mounted

这是 v1 必须明确的边界。

### 5.1 Contained

必须随 package 旅行的小而关键文件：

- prompt
- skill 内容
- self-mirror / system-mirror 文档
- hook 脚本
- 必需的 agent 规则文件

这些进入 package `files` manifest，并通过 blob store 分发。

### 5.2 Mounted

不放进 package，而是在运行时挂载：

- 代码仓库
- 团队共享目录
- 大型知识库
- 用户私有目录
- 外部数据卷

规则：

- 共享、大型、易变内容优先 mount
- 小型、关键、强可移植内容优先 contain

## 6. Generated Runtime Files

以下内容属于 generated artifacts：

- `.claude/settings.json`
- `.aha-agent/env.json`
- `.aha-agent/mcp.json`
- launch envelope
- daemon/session runtime state

这些文件：

- 可以 materialize 到本地
- 可以被 agent 读取做调试
- 但不允许作为主编辑面

正确修改路径是改上游 package 对象，再重新 materialize。

## 7. Agent Editing Model

AI Agent 的操作面应该分成两类。

### 7.1 Typed object ops

用于编辑结构化 manifest 字段：

- `set_behavior`
- `set_messaging`
- `set_allowed_tools`
- `set_disallowed_tools`
- `set_mounts`
- `set_runtime_policy`

### 7.2 Package file ops

用于编辑知识与内容文件：

- `read_package_file(path)`
- `patch_package_file(path, diff)`
- `write_package_file(path, content)`
- `delete_package_file(path)`

### 7.3 Explicit sync-back

本地 workspace 只是工作副本。

回写规则：

- 不允许静默整包覆盖
- 必须显式提交 patch / diff
- server 负责生成新版本与 ledger

## 8. Diff Model

之前的 diff 思路保留，但粒度必须提升。

### 8.1 Manifest diff

结构化字段变更：

```json
{
  "type": "manifest_set",
  "path": "behavior.onIdle",
  "value": "self-assign"
}
```

兼容说明：
- 历史调用里若传 `manifest.behavior.onIdle` 或 `manifest.genome.behavior.onIdle`，server 会向后兼容映射到 `behavior.onIdle`
- 新调用统一使用 spec 路径，不再写 `manifest.` 前缀

### 8.2 File diff

文件引用级别变更：

```json
{
  "type": "file_put",
  "path": "docs/system-mirror/how-agents-work.md",
  "hash": "sha256:b"
}
```

### 8.3 Explicit non-goal

以下内容不进入主 ledger：

- `.claude/settings.json` diff
- env materialization diff
- daemon state diff
- worktree 内偶发临时文件 diff

ledger 记录的是 package 的演化，不是 runtime 副本的噪音。

## 9. Transport Model

v1 transport 改为：

`manifest + blobs`

而不是：

`fat spec JSON`

### 9.1 Fetch path

1. client/daemon 先拉 package manifest
2. 根据 file manifest 判断本地 blob cache 缺什么
3. 只拉缺失 blobs
4. materialize 到 runtime workspace
5. 生成 runtime config files

### 9.2 Benefits

- 小改动不需要重传整份 spec
- blob 可去重
- 多 agent 可共享缓存
- spawn 更可控
- server 可做按需分发

## 10. Server Responsibilities

server 从 `entity(spec JSON) store` 升级为：

- package manifest store
- blob store
- diff ledger

最小 API 面：

### 10.1 Package fetch

`GET /entities/id/:id/package`

返回：

- package manifest
- file manifest
- version metadata

### 10.2 Blob fetch

`GET /blobs/:hash`

返回指定 blob 内容。

可选：

- `POST /blobs/batch`
- `HEAD /blobs/:hash`

### 10.3 Blob upload

`POST /blobs`

上传新文件内容，返回 `hash` 与 blob metadata。

### 10.4 Diff submit

`POST /entities/:id/diffs`

提交：

- manifest ops
- file ops
- referenced blob hashes

server 负责：

- 校验
- 版本推进
- ledger 落账

Phase 2 compatibility route:

- `POST /entities/id/:id/package-diffs`
- body carries `manifest_set`, `file_put`, `file_delete`
- server translates package ops into compatible entity diff/version creation

### 10.5 Optional materialization planning

`POST /entities/:id/materialize-plan`

可选接口，用于 server 预先给出：

- 需要哪些 blobs
- 哪些文件 requiredAtSpawn
- mount 解析结果

## 11. Materialization Contract

materializer 在 v1 的固定职责：

1. 拉 package manifest
2. hydrate required blobs
3. 写 contained files
4. 建立 mounts
5. 生成 runtime config files
6. 启动 agent runtime

materializer 不负责：

- 决定演化策略
- 决定评分策略
- 修改 package 真相源

## 12. Migration Path

为了兼容现有实现，采用三阶段迁移。

### Phase 1

保留旧 `spec.files`。

server 返回 package manifest 时：

- 将旧 `spec.files` 自动映射为 inline file entries
- 将旧 `skills[]` 视为 compatibility input，不再作为 portability guarantee

### Phase 2

引入 blob store。

- 小文件可以临时 inline
- 大文件转为 hash/blob ref
- client 增加本地 blob cache

### Phase 3

全面切到 package transport。

- spawn 改为 `manifest + blobs`
- 旧胖 `spec` 只作兼容读取
- generated runtime file 不再出现在 diff 主路径里

## 13. Decision Summary

最终固定规则如下：

1. Docker / OCI 继续做运行底座。
2. Aha 引入 `Agent Package` 作为 agent 的正式包格式。
3. `Agent Package` 使用 `manifest + file manifest + blobs`，不再长期依赖胖 JSON `files` KV。
4. 本地 workspace 是 materialized 副本，不是真相源。
5. generated runtime files 只读或调试可见，不作为主编辑面。
6. diff ledger 只记录 package 层变更，不记录 runtime 派生物。
7. server 必须提供 package fetch、blob fetch、blob upload、diff submit 能力。

## 14. Immediate Follow-ups

1. 定义 `aha.agent.package.v1` JSON schema。
2. 在 server 增加 package 与 blob API。
3. 在 CLI/materializer 增加 `manifest + blobs` 拉取路径。
4. 将 `context-mirror` 拆分为真正的 `self/system mirror` 与 `context hygiene`，并都归入 contained files。
