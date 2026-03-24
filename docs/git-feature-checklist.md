# Git Feature Checklist (4 Repos, git-derived)

> Date: 2026-03-19  
> Scope: recent shipped work extracted from Git history across `aha-cli`, `happy-server`, `kanban`, `genome-hub`  
> Purpose: turn recent commits into a **verification backlog** so the team can systematically check small and large features, including scoring, bypass agents, CRUD, marketplace, runtime materialization, and UI paths.

---

## 0. How this checklist was derived

I extracted this from recent Git history (primarily 2026-03-15 → 2026-03-19) using:

```bash
git -C <repo> log --since='2026-03-15' --date=short --pretty=format:'%h | %ad | %s' --stat
```

Included repos:
- `aha-cli`
- `happy-server`
- `kanban`
- `genome-hub`

Not included:
- `bb-browser` (capability layer, not part of the 4-repo task)
- pure local/runtime files (`.aha/*`, temp probes, local DB/env artifacts)

**Important:** unchecked items below are **not failures**. They are the git-derived validation backlog that should be tested with CLI, API, UI, logs, and bb-browser evidence.

---

## 1. Raw commit inventory used as sources

### `aha-cli`

- `3c66aa9` — `chore: snapshot v1`
  - bundled: `agentDocker/`, `agent.json` schema/examples, `sessions` CLI, model context windows, runtime materialization, docs
- `907582c` — `fix: add read_runtime_log and list_team_runtime_logs to toolNames`
- `c4d71d2` — `feat: Sprint 3 — teams commands, supervisor state, agent lifecycle, role fixes`
- `a2f4982` — `feat: Gene Schema evolution fields + injection (Cluster 2)`
- `de32570` — `chore: commit Sprint 2 WIP as baseline before CRUD Phase 2`
- `e987e30` — `fix(create_agent): define memberId+sessionTag before use`
- `aa6e891` — `feat(M3): genome-driven scoring + feedback privacy + session scoring`
- `ba52dbb` — `fix(supervisor): read_team_log rotation fallback`
- `1b5d066` — `feat: 硬性指标评分系统 v2 — BusinessMetrics + hardMetricsScore + gap guard`
- `8ac1636` — `feat: 硬性指标评分系统 — 客观指标替换主观5维度评分`
- `6f4e5d4` — `feat(M3): genome-driven agent lifecycle + supervisor feedback loop`
- `b3414fa` — `feat(F-001): request_help MCP tool — agent notifies supervisor via pendingAction`
- `0de839c` — `feat(F-026): integrate model router into runClaude + GenomeSpec.modelProvider`
- `7b5884c` — `feat(model-router): D-005+F-025 — ModelRouteConfig schema + TDD router`
- `a4044cc` — `feat: T-002+F-018 — fetchGenome URL tests + genome systemPromptSuffix overlay`
- `03a4a26` — `feat(genome): F-016 — daemon resolves @official/supervisor genome specId before spawn`
- `1692e6e` — `feat(genome): F-019 — create_genome tool supports namespace/tags/category`

### `happy-server`

- `c63ddb7` — `feat: agent CRUD routes, genome lifecycle, session activity cache fixes`
- `d61c14f` — `fix: make addTeamMember idempotent`
- `5c76b67` — `fix: ghost token detection in HTTP auth + WebSocket auth`
- `51c075c` — `feat: enable supervisor runtime log tools in system seed`
- `8baaba6` — `chore: commit Sprint 2 WIP as baseline before CRUD Phase 2`
  - bundled: team context CRUD, duplicate execution protection, execution links, commerce observability, auth/team-message changes
- `6519955` — `fix: reduce Node.js heap pressure and fix memory leaks`
- `18e7559` — `perf: cap Node.js heap at 2GB to prevent swap-driven SSD fill`
- `f4bd45d` — `fix: raise team message content limit from 2000 to 50000 chars`
- `a036e24` — `fix: increase team messages limit from 100 to 500 default (max 1000)`
- `25794ab` — `feat(F-024): POST /v1/genomes/:id/publish — Channel Server → Marketplace`
- `b3c79e6` — `feat(genome): F-015 — seed @official system genomes on startup`
- `640cc43` — `feat(genome): F-014 — versioned API /:namespace/:name/:version + /latest + /versions`
- `dcab240` — `feat(genome): add GET /v1/genomes/:id endpoint for CLI fetch`
- `1a7dacb` — `feat: M3 evolution routes + Genome schema`
- `489184d` — `test: add spec files for evolutionRoutes, sessionRoutes, teamManagement, sqliteDatabaseGuard`

### `kanban`

- `c4263de` — `chore: snapshot v1`
  - bundled: command-wall docs, teams/agents/new flows, sync/encryption/storage changes, i18n additions, agentModes, TeamChatRoom updates
- `df2ef9c` — `feat: CanonicalAgentCard types + isMachineOnline check`
- `9644e9e` — `fix: eliminate syncSessionToTeam event storm that froze ORG/master agents`
- `7f6bb7e` — `feat: add teamBoardState utility for sticky kanban board state`
- `a44fe2d` — `fix: agents/new desktop shell rendering + stability cleanup`
- `00ab36c` — `fix: register agents/new screen in Stack layout`
- `fe222e2` — `fix: ghost token, Team/Agent CRUD, i18n, and WebSocket auth stability`
- `ec1df95` — `feat: executionPlane metadata field + TeamStatusBar selectSignalsForDisplay`
- `012bc50` — `fix: P0 component persistence + Matrix theme unification`
- `002c400` — `feat: matrix persistence, team status bar signals, localSettings spec`
- `88699d7` — `feat: Matrix View + stable session roster + marketplace scaffolding`
- `980a6e3` — `fix: P0 global flicker — debounce machine-activity + atomic new-message`
- `9ea45ce` — `chore: commit Sprint 2 WIP as baseline before CRUD Phase 2`
  - bundled: agent detail page, terminal connect, home/sidebar polish, team chat/status, observability payload, persisted message count, UX walkthrough assets

### `genome-hub`

- `7e378c7` — `feat: Sprint 3 — genome routes, favorites, store expansion, lifecycle field`
- `d047a65` — `feat: Gene Schema lifecycle seed + migration (Cluster 2)`
- `71c5dab` — `feat(M3): genome-hub — working roles, corps, parentId lineage, feedback API`
- `792232e` — `feat: genome-hub production readiness`
- `7456a87` — `feat(F-023): CDN cache headers middleware for versioned genomes`
- `84829e6` — `feat: T-001+D-004 — Prisma SQLite DB + TDD API test suite`
- `4b52203` — `feat: F-022 — genome registry API (search/latest/versions/pinned/publish/namespace)`
- `8f6bc33` — `feat: genome-hub scaffold — Marketplace Server for agent genomes`
- `ca3b52e` — `chore: snapshot v1` (`src/types/genome.ts` expansion)

---

## 2. Validation streams

To reduce overlap, the checklist is grouped by the workstreams already active in Kanban:

- **Stream A** — Agent / Team / Session CRUD
- **Stream B** — Bypass plane / Supervisor / Help / Org-manager
- **Stream C** — Evolution / scoring / marketplace / genome lifecycle
- **Stream D** — Agent Docker / workspace / runtime materialization
- **Stream E** — UX / sync / stability / observability

---

## 3. Git-derived verification checklist

## Stream A — Agent / Team / Session CRUD

### A1. Team CLI + API CRUD
- [ ] Verify `aha teams list/show/create/members/add-member/remove-member/rename/archive/delete/batch-*`
  - Git source: `aha-cli c4d71d2`
  - Main files: `aha-cli/src/commands/teams.ts`
  - Evidence target: CLI output + API state before/after + team roster screenshot

### A2. Task CLI lifecycle
- [ ] Verify `aha tasks list/show/create/update/delete/start/complete`
  - Git source: `aha-cli c4d71d2`
  - Main files: `aha-cli/src/commands/tasks.ts`
  - Evidence target: CLI output + task row status transitions

### A3. Agent server CRUD routes
- [ ] Verify `POST/GET/PATCH/DELETE /v1/agents` and `POST /v1/agents/:id/promote`
  - Git source: `happy-server c63ddb7`
  - Main files: `happy-server/sources/app/api/routes/agentRoutes.ts`
  - Evidence target: request/response logs + UI visibility of created agent

### A4. Session direct management CLI
- [ ] Verify `aha sessions list/show/archive/delete`
  - Git source: `aha-cli 3c66aa9`
  - Main files: `aha-cli/src/commands/sessions.ts`
  - Evidence target: CLI output showing active/archive transitions

### A5. Standalone agent → team promotion path
- [ ] Verify standalone agent creation and later promotion to full team
  - Git source: `happy-server c63ddb7`
  - Main files: `happy-server/sources/app/api/routes/agentRoutes.ts`
  - Evidence target: API response, team creation side effect, roster screenshot

### A6. Team member add idempotency
- [ ] Verify repeated `add-member`/roster sync does not write/broadcast duplicates
  - Git source: `happy-server d61c14f`
  - Main files: `happy-server/sources/app/api/routes/teamManagementRoutes.ts`
  - Evidence target: repeated identical call + unchanged team log / DB result

### A7. TeamContext CRUD
- [ ] Verify `GET/PUT/PATCH/DELETE /v1/teams/:teamId/context`
  - Git source: `happy-server 8baaba6`
  - Main files: `happy-server/sources/app/api/routes/teamContextRoutes.ts`
  - Evidence target: API responses + persisted context readback

### A8. Client Team/Agent CRUD entry points
- [ ] Verify Kanban UI paths for Teams and Agents create/list/detail/delete are reachable and stable
  - Git source: `kanban fe222e2`, `a44fe2d`, `00ab36c`
  - Main files: `kanban/sources/app/(app)/agents/index.tsx`, `agents/new.tsx`, `teams/index.tsx`, `teams/new.tsx`
  - Evidence target: bb-browser walkthrough + screenshots of create/list/detail flows

---

## Stream B — Bypass plane / Supervisor / Help / Org-manager

### B1. `supervisor` is seeded as bypass
- [ ] Verify official/system seed records `supervisor` with `executionPlane: 'bypass'`
  - Git source: `happy-server b3c79e6`, `genome-hub 71c5dab/7e378c7`
  - Main files: `happy-server/sources/app/startup/seedSystemGenomes.ts`, `genome-hub/src/startup/seedOfficialGenomes.ts`
  - Evidence target: DB/API record + runtime/team roster evidence

### B2. `help-agent` is seeded as bypass
- [ ] Verify official/system seed records `help-agent` with `executionPlane: 'bypass'`
  - Git source: `happy-server b3c79e6`, `genome-hub 71c5dab/7e378c7`
  - Main files: same as above
  - Evidence target: DB/API record + bypass list response

### B3. `org-manager` is seeded as mainline
- [ ] Verify official/system seed records `org-manager` with `executionPlane: 'mainline'`
  - Git source: `happy-server b3c79e6`, `genome-hub 71c5dab/7e378c7`
  - Main files: same as above
  - Evidence target: DB/API record + team roster display

### B4. Bypass list endpoint only returns bypass members
- [ ] Verify `GET /v1/teams/:teamId/bypass-agents` filters to `executionPlane === 'bypass'`
  - Git source: `happy-server 1a7dacb`, `c63ddb7`
  - Main files: `happy-server/sources/app/api/routes/evolutionRoutes.ts`
  - Evidence target: API response showing supervisor/help only, excluding mainline builders/org-manager

### B5. Team detail UI correctly separates bypass/mainline members
- [ ] Verify team detail displays execution plane and keeps supervisor/help in bypass section
  - Git source: `kanban ec1df95`, `c4263de`
  - Main files: `kanban/sources/app/(app)/teams/[id].tsx`
  - Evidence target: team page screenshot with role + plane labels

### B6. Org-manager auto-spawn on team creation
- [ ] Verify create-team flow resolves `@official/org-manager` and spawns it on the selected machine
  - Git source: `kanban df2ef9c`, `c4263de`
  - Main files: `kanban/sources/app/(app)/teams/new.tsx`
  - Evidence target: bb-browser flow + resulting session/team member evidence

### B7. Daemon supervisor auto-spawn and help-agent spawn path
- [ ] Verify daemon spawns supervisor on active teams and help-agent on intervention path
  - Git source: `aha-cli 03a4a26`, `6f4e5d4`, `c4d71d2`
  - Main files: `aha-cli/src/daemon/run.ts`, `aha-cli/src/daemon/supervisorState.ts`
  - Evidence target: daemon logs + team/runtime logs + spawned session metadata

### B8. Supervisor state readback
- [ ] Verify `GET /v1/teams/:teamId/supervisor-state` returns persisted facts when state file exists
  - Git source: `happy-server 1a7dacb`, `489184d`
  - Main files: `happy-server/sources/app/api/routes/evolutionRoutes.ts`
  - Evidence target: API response + matching `.aha/supervisor/state-*.json`

---

## Stream C — Evolution / scoring / marketplace / genome lifecycle

### C1. Objective scoring system (hard metrics)
- [ ] Verify `score_agent` supports hard metrics and produces guarded objective score
  - Git source: `aha-cli 8ac1636`, `1b5d066`
  - Main files: `aha-cli/src/claude/utils/feedbackPrivacy.ts`, `startAhaServer.ts`, `scoreStorage.ts`
  - Evidence target: tool call payload + stored score excerpt + gap validation behavior

### C2. Business metrics + score-gap guard
- [ ] Verify `hardMetricsScore` and `overall` stay within configured gap, unless valid override
  - Git source: `aha-cli 1b5d066`
  - Main files: same as above
  - Evidence target: one passing example + one rejected gap example

### C3. Genome-driven scoring + privacy aggregation
- [ ] Verify session scores aggregate into genome feedback without leaking private evidence/session IDs
  - Git source: `aha-cli aa6e891`, `6f4e5d4`
  - Main files: `aha-cli/src/claude/utils/feedbackPrivacy.ts`, `sessionScoring.ts`
  - Evidence target: stored marketplace feedback JSON + absence of private fields

### C4. `request_help` → help lane trigger
- [ ] Verify `request_help` records supervisor action/help request path
  - Git source: `aha-cli b3414fa`
  - Main files: `aha-cli/src/claude/utils/startAhaServer.ts`
  - Evidence target: tool call + generated pendingAction/help request artifact/log

### C5. Versioned genome APIs on server
- [ ] Verify server endpoints: `GET /v1/genomes/:id`, `/:namespace/:name/latest`, `/:version`, `/versions`, `/publish`
  - Git source: `happy-server dcab240`, `640cc43`, `25794ab`, `1a7dacb`
  - Main files: `happy-server/sources/app/api/routes/evolutionRoutes.ts`
  - Evidence target: API responses from all read paths + publish path

### C6. Genome Hub registry core paths
- [ ] Verify Genome Hub supports `search/latest/versions/pinned/publish/namespace`
  - Git source: `genome-hub 8f6bc33`, `4b52203`, `84829e6`
  - Main files: `genome-hub/src/routes/genomeRoutes.ts`, `storage/genomeStore.ts`
  - Evidence target: direct Hub API responses

### C7. Favorites / fork / clone / download / spawn counters
- [ ] Verify public marketplace interactions update and round-trip correctly
  - Git source: `genome-hub 7e378c7`
  - Main files: `genome-hub/src/routes/genomeRoutes.ts`, `storage/genomeStore.ts`
  - Evidence target: API responses before/after + UI favorite state

### C8. Feedback-driven status and promotion
- [ ] Verify feedback can move genomes from `draft` → `verified` and gate promotion to next version
  - Git source: `genome-hub 71c5dab`, `7e378c7`
  - Main files: `genome-hub/src/storage/genomeStore.ts`, `src/routes/genomeRoutes.ts`
  - Evidence target: feedback patch response + promote success/failure cases

### C9. Working roles + corps templates + lineage
- [ ] Verify official roles/corps are queryable and lineage/parentId is persisted
  - Git source: `genome-hub 71c5dab`, `d047a65`
  - Main files: `genome-hub/src/startup/seedOfficialGenomes.ts`, `src/types/genome.ts`
  - Evidence target: `/corps`, `/genomes`, forked genome lineage fields

### C10. Marketplace UI scaffolding in Kanban
- [ ] Verify Agents page supports market/favorites/mine + agent/corps + category filters/search/sort
  - Git source: `kanban 88699d7`, `fe222e2`, `c4263de`
  - Main files: `kanban/sources/app/(app)/agents/index.tsx`, `sources/utils/agentMarketplace.ts`
  - Evidence target: bb-browser screenshots for each tab/filter state

### C11. Agent detail crowd review / feedback section
- [ ] Verify agent detail page shows crowd review / evaluation count / verdict / score breakdown
  - Git source: `kanban 9ea45ce`, `fe222e2`
  - Main files: `kanban/sources/app/(app)/agents/[id].tsx`
  - Evidence target: detail page screenshot with populated feedback section

### C12. Evolution section in Settings/Team detail
- [ ] Verify bypass agents, repair signals, supervisor state, and team genomes are visible in UI
  - Git source: `kanban a44fe2d`, `ec1df95`
  - Main files: `kanban/sources/components/settings/EvolutionSection.tsx`, `sources/sync/apiEvolution.ts`
  - Evidence target: UI screenshots + backing API responses

### C13. Model routing + model provider injection
- [ ] Verify model router respects role/execution-plane preferences and genome `modelProvider`
  - Git source: `aha-cli 7b5884c`, `0de839c`, `a4044cc`
  - Main files: `aha-cli/src/api/types/modelRoute.ts`, `src/claude/runClaude.ts`
  - Evidence target: runtime metadata / prompt excerpt / resolved model change

---

## Stream D — Agent Docker / workspace / runtime materialization

### D1. `aha agents spawn <agent.json>` local materialization path
- [ ] Verify CLI can spawn from local `agent.json` and register into a team
  - Git source: `aha-cli 3c66aa9`
  - Main files: `aha-cli/src/commands/agents.ts`, `src/agentDocker/materializer.ts`
  - Evidence target: CLI output + daemon spawn + roster entry

### D2. Agent JSON schema validation
- [ ] Verify schema/examples accept valid cards and reject malformed inputs
  - Git source: `aha-cli 3c66aa9`
  - Main files: `aha-cli/schemas/agent-json-v1.schema.json`, `examples/agent-json/*`
  - Evidence target: one passing sample + one rejected sample

### D3. Workspace overlay files
- [ ] Verify materialized workspace includes `.genome/spec.json`, `lineage.json`, `eval-criteria.md`
  - Git source: `aha-cli 3c66aa9`
  - Main files: `aha-cli/src/agentDocker/materializer.ts`, `prepareAgentRuntime.ts`
  - Evidence target: filesystem tree / file excerpts

### D4. Runtime-lib shared vs private resource policy
- [ ] Verify shared resources are symlinked and private resources are copied according to policy
  - Git source: `aha-cli 3c66aa9`
  - Main files: `aha-cli/src/agentDocker/materializer.ts`, `runtimeConfig.ts`
  - Evidence target: `ls -l` output of materialized workspace

### D5. `AHA_SETTINGS_PATH` / settingsPath precedence
- [ ] Verify injected settings path wins over genome spec when both exist
  - Git source: `aha-cli 3c66aa9` (documented in sprint notes)
  - Main files: `aha-cli/src/claude/utils/prepareAgentRuntime.ts`, docs bundle
  - Evidence target: effective runtime config + startup log excerpt

### D6. `effectiveCwd` and runtime bootstrap
- [ ] Verify spawned agent runs from materialized effective working directory, not a stale fallback path
  - Git source: `aha-cli 3c66aa9`
  - Main files: `aha-cli/src/claude/runClaude.ts`, `prepareAgentRuntime.ts`
  - Evidence target: session metadata + runtime cwd log

### D7. Sessions CLI model self-awareness
- [ ] Verify `aha sessions show` reports `resolvedModel` and `contextWindowTokens`
  - Git source: `aha-cli 3c66aa9`
  - Main files: `aha-cli/src/commands/sessions.ts`, `src/utils/modelContextWindows.ts`
  - Evidence target: CLI output for at least one running session

### D8. Agents model control plane
- [ ] Verify `aha agents update --model --fallback-model` persists and affects next restart
  - Git source: `aha-cli 3c66aa9`
  - Main files: `aha-cli/src/commands/agents.ts`
  - Evidence target: metadata diff before/after + post-restart runtime model

### D9. Runtime log MCP tools exposure
- [ ] Verify `list_team_runtime_logs` and `read_runtime_log` are callable in runtime tool surface
  - Git source: `aha-cli 907582c`, `c4d71d2`
  - Main files: `aha-cli/src/claude/utils/startAhaServer.ts`
  - Evidence target: tool inventory + one successful read

---

## Stream E — UX / sync / stability / observability

### E1. Team status signals
- [ ] Verify running / deciding / blocked signals are computed and rendered correctly
  - Git source: `kanban 002c400`, `ec1df95`, `012bc50`
  - Main files: `kanban/sources/components/team/TeamStatusBar.tsx`, `teamStatusSignals.ts`
  - Evidence target: team page screenshot + underlying task data sample

### E2. Sticky board state persistence
- [ ] Verify kanban board state persists across reload/navigation
  - Git source: `kanban 7f6bb7e`
  - Main files: `kanban/sources/utils/teamBoardState.ts`
  - Evidence target: before/after reload screenshots or local storage evidence

### E3. Sync storm freeze fix
- [ ] Verify repeated team/session sync does not freeze org/master agents or spam events
  - Git source: `kanban 9644e9e`
  - Main files: `kanban/sources/sync/sync.ts`
  - Evidence target: logs showing stable sync volume during repeated updates

### E4. Flicker / atomic message storage fix
- [ ] Verify new-message writes are atomic and machine-activity debounce removes P0 flicker
  - Git source: `kanban 980a6e3`
  - Main files: `kanban/sources/sync/storage.ts`, `reducer/machineActivityAccumulator.ts`
  - Evidence target: screen recording or before/after behavior notes

### E5. Agents/new desktop shell stability
- [ ] Verify `/agents/new` is registered and renders correctly in desktop shell
  - Git source: `kanban 00ab36c`, `a44fe2d`
  - Main files: `kanban/sources/app/(app)/_layout.tsx`, `agents/new.tsx`
  - Evidence target: bb-browser desktop screenshot + successful interaction

### E6. CanonicalAgentCard + machine-online guard
- [ ] Verify team creation / agent creation uses CanonicalAgentCard parsing and respects online machine checks
  - Git source: `kanban df2ef9c`
  - Main files: `kanban/sources/utils/genomeHub.ts`, `teams/new.tsx`
  - Evidence target: blocked flow on offline machine + success on online machine

### E7. Terminal connect flow
- [ ] Verify terminal connect confirmation flow works end-to-end from link to approval
  - Git source: `kanban 9ea45ce`, `df2ef9c`
  - Main files: `kanban/sources/app/(app)/terminal/connect.tsx`, `hooks/useConnectTerminal.ts`
  - Evidence target: bb-browser/mobile-web screenshots and resulting connection state

### E8. Commerce observability payloads
- [ ] Verify commerce event payload generation and server ingest path
  - Git source: `kanban 9ea45ce`, `happy-server 8baaba6`
  - Main files: `kanban/sources/observability/*`, `happy-server/sources/app/api/routes/commerceObservabilityRoutes.ts`
  - Evidence target: emitted payload + server receipt log

### E9. Tracking additions for session/task/governance
- [ ] Verify `trackSessionActivated`, `trackSessionTokenUsage`, `trackTaskFeedback`, `trackConflictDetected`, `trackAgentScopeViolation`
  - Git source: `kanban c4263de`
  - Main files: `kanban/sources/track/index.ts`
  - Evidence target: analytics debug output or intercepted event payloads

### E10. Team message scale and auth stability
- [ ] Verify long team messages, higher list limits, ghost-token auth fixes, and websocket auth behave correctly
  - Git source: `happy-server a036e24`, `f4bd45d`, `5c76b67`, `kanban fe222e2`
  - Main files: `happy-server/sources/app/api/routes/teamMessagesRoutes.ts`, `enableAuthentication.ts`, `kanban/sources/sync/apiSocket.ts`
  - Evidence target: long message send/read test + websocket reconnect logs

### E11. Server memory/heap stability
- [ ] Verify reduced heap pressure, 2GB cap, and memory-leak mitigations under sustained traffic
  - Git source: `happy-server 6519955`, `18e7559`
  - Main files: `happy-server/package.json`, `sessionCache.ts`, `teamMessagesRoutes.ts`
  - Evidence target: runtime memory logs / `ps` sample during soak

---

## 4. Priority subset the team should validate first

If the team needs a **minimum high-value pass list**, start with these 12 items:

1. [ ] A3 — Agent server CRUD routes
2. [ ] B1 — supervisor seeded/runs in bypass
3. [ ] B2 — help-agent seeded/runs in bypass
4. [ ] B3 — org-manager seeded/runs in mainline
5. [ ] B4 — bypass list endpoint filters correctly
6. [ ] C1 — objective scoring system works
7. [ ] C3 — genome feedback aggregation/privacy works
8. [ ] C7 — favorites/fork/clone/download/spawn counters work
9. [ ] D1 — `aha agents spawn <agent.json>` works end-to-end
10. [ ] D3 — `.genome/*` workspace overlay files are materialized
11. [ ] E5 — `/agents/new` desktop path works
12. [ ] E10 — long team message + auth/websocket stability

---

## 5. Evidence format to use during validation

For each checked item, capture:

1. **Checklist result** — `✅ pass` / `❌ fail` / `⚠️ partial`
2. **Bug list** — short repro if anything breaks
3. **Evidence** — one of:
   - bb-browser screenshot
   - CLI output snippet
   - API request/response excerpt
   - runtime log excerpt
   - filesystem tree / file excerpt

Recommended evidence naming pattern:

```text
artifacts/validation/<item-id>-<short-name>.png
artifacts/validation/<item-id>-<short-name>.txt
```

Example:

```text
artifacts/validation/B4-bypass-agents-response.txt
artifacts/validation/D3-materialized-genome-tree.txt
artifacts/validation/E5-agents-new-desktop.png
```

---

## 6. Suggested coordination mapping

- **Builder-Codex-2** → Stream A + Stream B
- **Builder-Codex-3** → Stream C
- **Builder-Claude-1 / Builder-Codex-4 Docker** → Stream D
- **Master / UI verifier** → Stream E with bb-browser

This split keeps the Git-derived checklist aligned with the existing Kanban specialization and minimizes overlap.

