# Aha CLI Codebase Overview

## 多域名单包设计（待实现）

目标：一个 npm 包（`aha-agi-v2`）支持多域名部署 + A/B 分流。

```
npx aha-agi-v2 --server https://aha-agi.com    → wow 测试
npx aha-agi-v2 --server https://ahaagi.com      → 生产
npx aha-agi-v2                                    → 默认生产
```

### 需要改的 3 处
1. **package.json**: name 从 `aha-agi` 改为 `aha-agi-v2`
2. **src/index.ts**: 加 `--server <url>` CLI flag，覆盖 `AHA_SERVER_URL` 和 `GENOME_HUB_URL`
3. **kanban cliCommands.ts**: 粘贴命令从 `npm i aha-agi` 改为 `npm i ${EXPO_PUBLIC_CLI_PACKAGE}` + `--server ${EXPO_PUBLIC_HAPPY_SERVER_URL}`（已改）

### 已有支持
- `AHA_SERVER_URL` 环境变量（`src/configurationResolver.ts:76`）
- `GENOME_HUB_URL` 环境变量（`src/configurationResolver.ts:9`）
- `~/.aha/settings.json` 持久化配置（`serverUrl` 字段）

### A/B 分流
- 同一个包，不同 `--server` 指向不同 happy-server
- 两个 happy-server 连同一个 genome-hub（single truth）
- namespace 隔离：`@experiment-a/*` vs `@experiment-b/*`
- 30 处 `@official` 硬编码需提取为配置后才能真正支持（见 05-代码质量约束.md）

## Genome Schema 同步规则

修改 `src/api/types/genome.ts`（AgentImage / LegionImage / AgentPlug）时，必须同步检查 genome-hub 的 `src/types/genome.ts`。
- genome-hub 是 single truth：字段定义以 hub 为准
- aha-cli 是 consumer：可以多（解析函数、Zod runtime schema），不能少（hub 有的字段 cli 必须有）
- 改完后跑 `docker build --target test-l1` 确认 tsc + vitest 绿

## Testing Rule

All build, test, and daemon verification MUST run inside Docker (`Dockerfile.test`), never on the host machine.
- `npm publish` + `npm install` 污染 `~/node_modules` — 禁止在宿主机直接跑
- daemon restart 会杀正在跑的 agent session — 禁止在宿主机直接跑
- L1（单测/tsc）: `docker build --target test-l1` — 无需 API key
- L2（daemon 集成）: `docker build --target test-l2 --build-arg ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY`

## Project Overview

Aha CLI (`aha-cli`) is a command-line tool that wraps Claude Code to enable remote control and session sharing. It's part of a three-component system:

1. **aha-cli** (this project) - CLI wrapper for Claude Code
2. **aha** - React Native mobile client
3. **aha-server** - Node.js server with Prisma (hosted at https://api.aha-servers.com/)

## Code Style Preferences

### TypeScript Conventions
- **Strict typing**: No untyped code ("I despise untyped code")
- **Clean function signatures**: Explicit parameter and return types
- **As little as possible classes**
- **Comprehensive JSDoc comments**: Each file includes header comments explaining responsibilities.
- **Import style**: Uses `@/` alias for src imports, e.g., `import { logger } from '@/ui/logger'`
- **File extensions**: Uses `.ts` for TypeScript files
- **Export style**: Named exports preferred, with occasional default exports for main functions

### DO NOT

- Create stupid small functions / getters / setters
- Excessive use of `if` statements - especially if you can avoid control flow changes with a better design
- **NEVER import modules mid-code** - ALL imports must be at the top of the file
- For Agent Docker work, **DO NOT** push agent-specific injection logic down into:
  - `src/claude/sdk/*`
  - `src/claude/session.ts`
  - equivalent Codex base wrapper layers
- Agent Docker belongs at the package parser / workspace materializer / runtime adapter layer.

### Error Handling
- Graceful error handling with proper error messages
- Use of `try-catch` blocks with specific error logging
- Abort controllers for cancellable operations
- Careful handling of process lifecycle and cleanup

### Testing
- Unit tests using Vitest
- No mocking - tests make real API calls
- Test files colocated with source files (`.test.ts`)
- Descriptive test names and proper async handling

### Logging
- All debugging through file logs to avoid disturbing Claude sessions
- Console output only for user-facing messages
- Special handling for large JSON objects with truncation

## Architecture & Key Components

### 1. API Module (`/src/api/`)
Handles server communication and encryption.

- **`api.ts`**: Main API client class for session management
- **`apiSession.ts`**: WebSocket-based real-time session client with RPC support
- **`auth.ts`**: Authentication flow using TweetNaCl for cryptographic signatures
- **`encryption.ts`**: End-to-end encryption utilities using TweetNaCl
- **`types.ts`**: Zod schemas for type-safe API communication

**Key Features:**
- End-to-end encryption for all communications
- Socket.IO for real-time messaging
- Optimistic concurrency control for state updates
- RPC handler registration for remote procedure calls

### 2. Claude Integration (`/src/claude/`)
Core Claude Code integration layer.

- **`loop.ts`**: Main control loop managing interactive/remote modes
- **`types.ts`**: Claude message type definitions with parsers

- **`claudeSdk.ts`**: Direct SDK integration using `@anthropic-ai/claude-code`
- **`interactive.ts`**: **LIKELY WILL BE DEPRECATED in favor of running through SDK** PTY-based interactive Claude sessions
- **`watcher.ts`**: File system watcher for Claude session files (for interactive mode snooping)

- **`mcp/startPermissionServer.ts`**: MCP (Model Context Protocol) permission server

**Key Features:**
- Dual mode operation: interactive (terminal) and remote (mobile control)
- Session persistence and resumption
- Real-time message streaming
- Permission intercepting via MCP [Permission checking not implemented yet]

### Agent Docker v1 Boundary

Agent Docker v1 is a flat `agent.json` package format with these runtime components:

- `tools.mcpServers`
- `tools.skills`
- `hooks.*`
- `env.*`
- `routing.*`

Important:

- keep the JSON flat; concept groups live in docs, not artificial nested sections
- do not solve hooks/skills/env by patching SDK internals
- solve them by **workspace materialization**

Preferred runtime model:

- `shared` workspace mode for ordinary team execution
- `isolated` workspace mode for agent-specific hooks or mutation experiments

Runtime materialization should produce an agent-specific working view, e.g.:

```text
.aha/runtime/<agent-id>/
  workspace/
    .claude/
      settings.json
      commands/
  logs/
  cache/
  tmp/
```

Shared read-only resources may be linked in.
Mutable or secret-bearing resources must remain instance-isolated.

### Agent Runtime Materializer v1

The materializer is now the preferred integration point for Agent Docker runtime setup.

It should:

- read `agent.json`
- read repo root and workspace mode
- create `.aha/runtime/<agent-id>/`
- materialize an agent-specific runtime workspace view

It should not:

- patch npm-installed SDK internals
- push agent-specific logic into `src/claude/sdk/*`
- push agent-specific logic into `src/claude/session.ts`

v1 responsibilities:

- hooks -> per-agent effective settings
- skills -> per-agent visible command view
- env -> per-agent validation/materialization
- logs/cache/tmp -> per-agent directories

Shared public resources may be linked in from runtime libraries.
Mutable effective config must be per-agent.

### Codex Bridge Compatibility

- `aha-cli` does **not** embed Codex. It invokes the system-installed `codex` CLI.
- Current bridge compatibility target: `codex-cli 0.117.0`
- Treat Codex bridge issues as **event-model compatibility** problems first, not RPC problems first.
- The current version-specific event families to watch are:
  - `item_started`
  - `item_completed`
  - `raw_response_item`
  - `mcp_tool_call_begin`
  - `mcp_tool_call_end`
  - `exec_command_output_delta`
- If Codex is upgraded, verify the bridge again before assuming regressions come from Kanban or transport.

## Team 交付隔离记录（2026-03-18）

> The following changes were completed as one coordinated **team-delivered batch**. Because they span runtime setup, CLI commands, model control, Docker validation, and genome workspace behavior, keep them mentally grouped as an isolated change set when debugging regressions.

### Included in this batch
- Materializer v1 integration in `runClaude.ts`
  - `buildAgentWorkspacePlanFromGenome()`
  - `materializeAgentWorkspace()`
  - `settingsPath` propagation
  - `effectiveCwd` handoff
- Shared runtime-lib support
  - `runtime-lib/{skills,mcp,prompts,hooks,tools}`
  - symlink/copy helpers
  - `materializationPolicy` resolution
- `.genome/` workspace overlay
  - `.genome/spec.json`
  - `.genome/lineage.json`
  - `.genome/eval-criteria.md`
  - `__genome_ref__` self-awareness injection
- CLI additions
  - `aha sessions list/show/archive/delete`
  - `aha agents spawn <agent.json>`
- Model control plane and agent self-awareness
  - `aha agents update --model --fallback-model`
  - `update_agent_model` MCP tool
  - `MODEL_CONTEXT_WINDOWS`
  - `resolvedModel` / `contextWindowTokens`
- Docker / agent-json verification pyramid
  - schema validation
  - materializer artifact checks
  - hook / skill mechanism tests
  - Layer 3/4 CI-capable tests
- Team display repair
  - default `executionPlane` / `runtimeType` in `list_team_agents`
  - `org-manager` is `mainline`, not `bypass`

### Why this section is isolated
- These changes are intentionally grouped because failures may appear unrelated while sharing the same rollout.
- If you see regressions in session startup, settings loading, genome-backed sessions, Docker-spawned agents, team roster display, or model visibility, inspect this batch first.
- Treat this as a broad infrastructure rollout, not as isolated one-off patches.

### 3. UI Module (`/src/ui/`)
User interface components.

- **`logger.ts`**: Centralized logging system with file output
- **`qrcode.ts`**: QR code generation for mobile authentication
- **`start.ts`**: Main application startup and orchestration

**Key Features:**
- Clean console UI with chalk styling
- QR code display for easy mobile connection
- Graceful mode switching between interactive and remote

### 4. Core Files

- **`index.ts`**: CLI entry point with argument parsing
- **`persistence.ts`**: Local storage for settings and keys
- **`utils/time.ts`**: Exponential backoff utilities

## Data Flow

1. **Authentication**: 
   - Generate/load secret key → Create signature challenge → Get auth token

2. **Session Creation**:
   - Create encrypted session with server → Establish WebSocket connection

3. **Message Flow**:
   - Interactive mode: User input → PTY → Claude → File watcher → Server
   - Remote mode: Mobile app → Server → Claude SDK → Server → Mobile app

4. **Permission Handling**:
   - Claude requests permission → MCP server intercepts → Sends to mobile → Mobile responds → MCP approves/denies

## Key Design Decisions

1. **File-based logging**: Prevents interference with Claude's terminal UI
2. **Dual Claude integration**: Process spawning for interactive, SDK for remote
3. **End-to-end encryption**: All data encrypted before leaving the device
4. **Session persistence**: Allows resuming sessions across restarts
5. **Optimistic concurrency**: Handles distributed state updates gracefully

## Security Considerations

- Private keys stored in `~/.aha/access.key` with restricted permissions
- All communications encrypted using TweetNaCl
- Challenge-response authentication prevents replay attacks
- Session isolation through unique session IDs

## Dependencies

- Core: Node.js, TypeScript
- Claude: `@anthropic-ai/claude-code` SDK
- Networking: Socket.IO client, Axios
- Crypto: TweetNaCl
- Terminal: node-pty, chalk, qrcode-terminal
- Validation: Zod
- Testing: Vitest 


## 🔴 Org-Manager 系统级工具制约（2026-03-21，待解决）

> 解决后从本节移除。

### 待实现工具

1. **`restart_daemon`** MCP tool — 修改 aha-cli 源码（controlServer.ts, supervisorTools.ts, mcpContext.ts, run.ts）后，agent 无法让变更生效，需手动重启 daemon。建议实现 graceful restart MCP tool。（优先级：高）

2. **`tsc_check(path)`** MCP tool — aha-cli 需要 Node 22（`.node-version=22`），当前 shell 默认 Node 24 下 tsc OOM crash。需要一个工具自动 `fnm use` 读取 `.node-version` 后执行 tsc。（优先级：高）

3. **`git_diff_summary`** — supervisor 评分只看 CC log，不读 git diff。org-manager 修复 P0 级 daemon 问题但被评 45/100。supervisor 应能看到代码变更的范围和影响。（优先级：中）

### Node 环境注意事项

- aha-cli 构建/类型检查必须在 Node 22 下运行
- 执行前先 `fnm use 22`，再加 `NODE_OPTIONS="--max-old-space-size=8192"`
- daemon 启动时应自动读取 `.node-version` 切换 Node 版本

# Running the Daemon

## Starting the Daemon
```bash
# From the aha-cli directory:
./bin/aha.mjs daemon start

# With custom server URL (for local development):
AHA_SERVER_URL=http://localhost:3005 ./bin/aha.mjs daemon start

# Stop the daemon:
./bin/aha.mjs daemon stop

# Check daemon status:
./bin/aha.mjs daemon status
```

## Daemon Logs
- Daemon logs are stored in `~/.aha-dev/logs/` (or `$AHA_HOME_DIR/logs/`)
- Named with format: `YYYY-MM-DD-HH-MM-SS-daemon.log`

# Session Forking `claude` and sdk behavior

## Commands Run

### Initial Session
```bash
claude --print --output-format stream-json --verbose 'list files in this directory'
```
- Original Session ID: `aada10c6-9299-4c45-abc4-91db9c0f935d`
- Created file: `~/.claude/projects/.../aada10c6-9299-4c45-abc4-91db9c0f935d.jsonl`

### Resume with --resume flag
```bash
claude --print --output-format stream-json --verbose --resume aada10c6-9299-4c45-abc4-91db9c0f935d 'what file did we just see?'
```
- New Session ID: `1433467f-ff14-4292-b5b2-2aac77a808f0`
- Created file: `~/.claude/projects/.../1433467f-ff14-4292-b5b2-2aac77a808f0.jsonl`

## Key Findings for --resume

### 1. Session File Behavior
- Creates a NEW session file with NEW session ID
- Original session file remains unchanged
- Two separate files exist after resumption

### 2. History Preservation
- The new session file contains the COMPLETE history from the original session
- History is prefixed at the beginning of the new file
- Includes a summary line at the very top

### 3. Session ID Rewriting
- **CRITICAL FINDING**: All historical messages have their sessionId field UPDATED to the new session ID
- Original messages from session `aada10c6-9299-4c45-abc4-91db9c0f935d` now show `sessionId: "1433467f-ff14-4292-b5b2-2aac77a808f0"`
- This creates a unified session history under the new ID

### 4. Message Structure in New File
```
Line 1: Summary of previous conversation
Lines 2-6: Complete history from original session (with updated session IDs)
Lines 7-8: New messages from current interaction
```

### 5. Context Preservation
- Claude successfully maintains full context
- Can answer questions about previous interactions
- Behaves as if it's a continuous conversation

## Technical Details

### Original Session File Structure
- Contains only messages from the original session
- All messages have original session ID
- Remains untouched after resume

### New Session File Structure After Resume
```json
{"type":"summary","summary":"Listing directory files in current location","leafUuid":"..."}
{"parentUuid":null,"sessionId":"1433467f-ff14-4292-b5b2-2aac77a808f0","message":{"role":"user","content":[{"type":"text","text":"list files in this directory"}]},...}
// ... all historical messages with NEW session ID ...
{"parentUuid":"...","sessionId":"1433467f-ff14-4292-b5b2-2aac77a808f0","message":{"role":"user","content":"what file did we just see?"},...}
```

## Implications for aha-cli

When using --resume:
1. Must handle new session ID in responses
2. Original session remains as historical record
3. All context preserved but under new session identity
4. Session ID in stream-json output will be the new one, not the resumed one
