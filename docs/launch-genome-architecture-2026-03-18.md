# Launch Architecture: Genome Library / Agent Classification / Help+Supervisor

Date: 2026-03-18
Author: solution-architect
Scope: `aha-cli` + `happy-server` + `genome-hub` + `kanban`

## 1. Repo findings

### 1.1 Canonical GenomeSpec is currently split
- `aha-cli/src/api/types/genome.ts` is the closest thing to the runtime-canonical spec.
- `genome-hub/src/types/genome.ts` duplicates most fields for the marketplace server.
- `kanban/sources/utils/genomeHub.ts` contains a display subset for UI rendering.

### 1.2 Runtime behavior today
- Claude runtime already consumes `modelId`, `fallbackModelId`, `allowedTools`, `disallowedTools`, `permissionMode`, `systemPrompt`, and `systemPromptSuffix` in `aha-cli/src/claude/runClaude.ts`.
- Codex runtime already consumes genome memory injection via `buildGenomeInjection()` in `aha-cli/src/codex/runCodex.ts`, but runtime-specific adapter fields are not fully modeled yet.
- `buildGenomeInjection()` already compiles `memory`, `resume`, `operations`, `scopeOfResponsibility`, and model preferences into deterministic prompt blocks.

### 1.3 Marketplace / persistence today
- Private/local genome persistence lives in `happy-server` `Genome` table.
- Public marketplace persistence lives in `genome-hub`.
- Current DB already has lifecycle-ish fields: `status`, `origin`, `variantOf`, `mutationNote`, `hubGenomeId`, `spawnCount`.
- Current UI already shows marketplace cards, favorites, download/star counters, runtime badge, and crowd score in `kanban/sources/app/(app)/agents/*`.

### 1.4 Supervisor state today
- `aha-cli/src/daemon/supervisorState.ts` already persists:
  - `teamLogCursor`
  - `ccLogCursors`
  - `codexHistoryCursor`
  - `codexSessionCursors`
- `save_supervisor_state` already accepts Codex cursor fields.
- Gap: read-path/tooling is still Claude-first (`read_cc_log`, `list_team_cc_logs` naming and behavior), so supervisor enhancement should expose Codex evidence as first-class log sources.

---

## 2. Core architecture decision

The launch-ready agent DNA should be split into **four layers** instead of one flat spec:

1. **Genome Core** — the portable behavioral DNA
2. **Runtime Adapter** — how the genome runs on Claude / Codex / OpenCode
3. **Evidence Resume** — what the agent has actually done and how well it performed
4. **Market Profile** — what users see, search, trust, and choose in the marketplace

### Why this split matters
If we keep everything in a single flat spec, runtime-specific details (`CLAUDE.md`, `AGENTS.md`, Codex sandbox rules, hooks) will pollute portable behavior. For launch, we need one genome to support multiple runtimes while preserving a unified resume and storefront identity.

---

## 3. Proposed canonical schema shape

## 3.1 Top-level model

```ts
interface GenomeSpecV3 {
    identity: GenomeIdentity;
    core: GenomeCore;
    runtime: RuntimeAdapterSpec[];
    memory?: MemoryProfile;
    collaboration?: CollaborationProfile;
    governance?: GovernanceProfile;
    resume?: EvidenceResume;
    market?: MarketProfile;
    release?: ReleaseProfile;
    lineage?: LineageProfile;
    observability?: ObservabilityProfile;
    meta?: Record<string, unknown>;
}
```

## 3.2 Identity layer

```ts
interface GenomeIdentity {
    displayName?: string;
    description?: string;
    baseRoleId?: string;
    namespace?: string;
    name?: string;
    version?: number;
    category?: string;
    tags?: string[];
    discoveryTags?: string[];
}
```

## 3.3 Core DNA

```ts
interface GenomeCore {
    systemPrompt?: string;
    systemPromptSuffix?: string;
    responsibilities?: string[];
    protocol?: string[];
    capabilities?: string[];
    teamRole?: string;
    messaging?: {
        listenFrom?: string[] | '*';
        receiveUserMessages?: boolean;
        replyMode?: 'proactive' | 'responsive' | 'passive';
    };
    behavior?: {
        onIdle?: 'wait' | 'self-assign' | 'ask';
        onBlocked?: 'report' | 'escalate' | 'retry';
        canSpawnAgents?: boolean;
        requireExplicitAssignment?: boolean;
    };
}
```

## 3.4 Runtime adapter

```ts
type AgentRuntime = 'claude' | 'codex' | 'open-code' | 'custom';

interface RuntimeAdapterSpec {
    runtime: AgentRuntime;
    entry: {
        instructionFile?: string;     // CLAUDE.md / AGENTS.md / SYSTEM.md
        bootstrapPrompt?: string;
        workingDirectoryMode?: 'inherit' | 'fixed';
    };
    model?: {
        provider?: 'anthropic' | 'openai' | 'local' | 'zhipu';
        primary?: string;
        fallback?: string;
        preferred?: string;
        scores?: Record<string, number>;
    };
    tools?: {
        allowed?: string[];
        disallowed?: string[];
        initialTools?: string[];
        mcpServers?: string[];
        skills?: string[];
        hooks?: {
            preToolUse?: Array<{ matcher: string; command: string; description?: string }>;
            postToolUse?: Array<{ matcher: string; command: string; description?: string }>;
            stop?: Array<{ command: string; description?: string }>;
        };
    };
    sandbox?: {
        permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
        accessLevel?: 'read-only' | 'full-access';
        executionPlane?: 'mainline' | 'bypass';
        maxTurns?: number;
    };
    env?: {
        requiredEnvVars?: string[];
        optionalEnvVars?: string[];
        externalServices?: string[];
        secretsPolicy?: string[];
    };
    ioContract?: {
        expects?: string[];
        produces?: string[];
        artifactFormats?: string[];
    };
    compatibility?: {
        worksWellWith?: string[];
        requiredMcpServers?: string[];
        minContextTokens?: number;
    };
}
```

## 3.5 Memory / collaboration / governance

```ts
interface MemoryProfile {
    type?: 'session' | 'persistent' | 'shared' | 'hybrid';
    persistence?: {
        strategy?: 'none' | 'file' | 'kv' | 'artifact' | 'database' | 'mixed';
        namespace?: string;
        retentionDays?: number;
        writePolicy?: 'manual' | 'auto-summary' | 'event-driven';
        recallPolicy?: 'manual' | 'auto-on-start' | 'auto-on-threshold';
    };
    learnings?: string[];
    knowledgeBase?: string[];
    iterationGuide?: {
        recentChanges?: string[];
        discoveries?: string[];
        improvements?: string[];
        workResume?: string[];
    };
    provenance?: Array<{
        kind: 'human' | 'supervisor' | 'agent' | 'market-feedback';
        summary: string;
        source?: string;
        recordedAt?: string;
    }>;
}

interface CollaborationProfile {
    commonCollaborators?: string[];
    handoffProtocol?: string[];
    escalationPath?: string[];
    taskIntakeRules?: string[];
    trigger?: {
        events?: string[];
        mentions?: string[];
        autoJoinConditions?: string[];
    };
}

interface GovernanceProfile {
    scopeOfResponsibility?: {
        ownedPaths?: string[];
        forbiddenPaths?: string[];
        outOfScope?: string[];
    };
    permissionManifest?: {
        allowedActions?: string[];
        approvalRequiredFor?: string[];
        forbiddenActions?: string[];
    };
    failureModes?: Array<{
        pattern: string;
        mitigation?: string;
        severity?: 'low' | 'medium' | 'high';
    }>;
    evalCriteria?: {
        successSignals?: string[];
        rejectionSignals?: string[];
        scoreDimensions?: string[];
    };
}
```

## 3.6 Resume / market / release / lineage / observability

```ts
interface EvidenceResume {
    specialties?: string[];
    workHistory?: Array<{
        project?: string;
        domain?: string;
        tasksCompleted?: number;
        avgScore?: number;
        period?: string;
        evidenceLinks?: string[];
    }>;
    performanceRating?: number;
    totalSessions?: number;
    reviews?: string[];
    proofOfWork?: string[];
    recentWins?: string[];
    modelOutcomeNotes?: string[];
    costProfile?: {
        estimatedTokensPerTask?: number;
        contextWindowSize?: 'small' | 'medium' | 'large';
        concurrencyCapable?: boolean;
        relativeCostTier?: 'low' | 'medium' | 'high';
    };
    liveMetrics?: {
        avgLatencyMs?: number;
        successRate?: number;
        rollbackRate?: number;
        lastEvaluatedAt?: string;
    };
}

interface MarketProfile {
    title?: string;
    tagline?: string;
    targetUsers?: string[];
    useCases?: string[];
    trustSignals?: string[];
    badges?: Array<'official' | 'verified' | 'crowd-proven' | 'experimental'>;
    searchBoostTerms?: string[];
    installNotes?: string[];
}

interface ReleaseProfile {
    lifecycle?: 'draft' | 'internal' | 'beta' | 'public' | 'deprecated' | 'archived';
    origin?: 'manual' | 'auto-created' | 'forked' | 'mutated' | 'market-installed';
    publishState?: 'private' | 'team' | 'public-market';
    releaseChecklist?: string[];
}

interface LineageProfile {
    variantOf?: string;
    parentGenomeId?: string;
    mutationNote?: string;
    mutationReason?: string;
    evolutionTrack?: Array<{
        version: number;
        summary: string;
        impact?: string;
        changedAt?: string;
    }>;
}

interface ObservabilityProfile {
    logging?: {
        sessionLogs?: boolean;
        toolCalls?: boolean;
        scoreUploads?: boolean;
        marketFeedback?: boolean;
    };
    healthChecks?: string[];
    smokeTest?: {
        requiredTools?: string[];
        requiredFiles?: string[];
        healthChecks?: string[];
    };
}
```

---

## 4. Mapping old flat fields to new layered model

### Keep as compatibility aliases for launch
To avoid a flag day migration, keep current flat fields during launch, but treat them as shims into the new layered model.

| Old field | New home |
|---|---|
| `displayName`, `description`, `namespace`, `version`, `tags`, `category` | `identity` |
| `systemPrompt`, `systemPromptSuffix`, `responsibilities`, `protocol`, `capabilities`, `teamRole` | `core` |
| `modelId`, `fallbackModelId`, `modelProvider`, `preferredModel`, `modelScores` | `runtime[].model` |
| `allowedTools`, `disallowedTools`, `mcpServers`, `skills`, `hooks` | `runtime[].tools` |
| `permissionMode`, `accessLevel`, `executionPlane`, `maxTurns` | `runtime[].sandbox` |
| `memory.*` | `memory` |
| `scopeOfResponsibility` | `governance.scopeOfResponsibility` |
| `resume.*` | `resume` |
| `operations.*` | split between `runtime[].entry`, `memory.iterationGuide`, `resume`, `observability` |
| `compatibility`, `validation`, `resourceBudget` | `runtime[].compatibility`, `observability`, `resume.costProfile` |

---

## 5. What was missing from the original idea

The user proposal already covered most of the useful DNA. The missing launch-critical fields are:

1. **lineage** — who this genome came from and why it changed
2. **environment contract** — env vars / services / secret expectations
3. **I/O contract** — what inputs it expects and what artifacts it emits
4. **permission manifest** — what it may do without approval vs never do
5. **live metrics** — operational health beyond static resume
6. **provenance** — where memory/learnings came from
7. **eval criteria** — how supervisors and users judge success
8. **cost profile** — launch-time user decision factor
9. **failure modes** — where the agent predictably underperforms
10. **discovery tags** — search/ranking layer distinct from technical tags

These align with org-manager’s added fields (`trigger`, `provenance`, `evalCriteria`, `costProfile`, `failureModes`, `lifecycle`, `discoveryTags`) and Master’s requested supplements (`Lineage`, `Environment Contract`, `I/O Contract`, `Live Metrics`, `Permission Manifest`).

---

## 6. Runtime-specific answer: “Do we have Docker-like specialness?”

Yes — but it is **not** container-image specialness. It is **runtime adapter specialness**.

### For this product, “Agent Docker” should mean:
- a portable genome core
- plus one or more runtime adapters
- plus stable market identity and resume

### Concrete runtime differences

#### Claude adapter
- instruction file: `CLAUDE.md`
- permission mode maps cleanly to Claude execution
- genome prompt overlays are already wired in `runClaude.ts`
- hooks map naturally to Claude hook lifecycle

#### Codex adapter
- instruction file: `AGENTS.md`
- session config uses `base-instructions`, `sandbox`, `approval-policy`
- genome memory injection exists, but adapter-level fields should drive Codex session bootstrap more explicitly
- `/compact` and resume behavior differ from Claude and must remain adapter-specific

#### OpenCode / custom adapters
- same genome core can remain unchanged
- only adapter contract changes (entry file, sandbox, tools, env, hook semantics)

**Conclusion:** the canonical schema must allow **multiple adapters per genome**; a single `runtimeType` top-level string is too weak for launch.

---

## 7. Agent 3-type classification system

Use two parallel axes:

### Axis A — distribution type
- `org` — internal organization/system genomes (org-manager, supervisor, help-agent)
- `runtime` — execution-specialized genomes tied to a runtime/persona (Codex builder, Claude reviewer)
- `market` — public storefront products intended for search/install/fork/use

### Axis B — execution role
Keep existing role/category concepts (`coordination`, `support`, `execution`, etc.) instead of replacing them.

### Proposed field

```ts
interface AgentClassification {
    distributionType: 'org' | 'runtime' | 'market';
    executionRole?: string;
    audience?: 'internal' | 'team' | 'public';
    maturity?: 'experimental' | 'stable' | 'production';
}
```

### Why two axes
A public market genome can still be a coordination agent. A runtime genome can still be internal-only. One enum is not expressive enough.

---

## 8. Long-term memory architecture

Use a **hybrid persistence model**, not a single storage system.

### 8.1 Three memory classes
1. **Session memory** — transient conversational context
2. **Genome memory** — persistent learnings that belong to the genome version/family
3. **Team/project memory** — persistent context belonging to a repo/team, not a single genome

### 8.2 Storage choices by memory class

#### A. File-based memory (best for local agent evolution)
Location examples:
- `.memory/genomes/<genome-id>.json`
- `.memory/projects/<project-key>.json`
- `.mermaid/memory/*` for architecture learnings

Use for:
- iteration guide
- work resume bullets
- local learnings
- replayable architecture gotchas

#### B. KV / artifact memory (best for team-shared context)
Existing candidates:
- `happy-server` KV store
- team artifacts / team context entries

Use for:
- shared team preferences
- active handoff context
- supervisor summaries
- project-level stable conventions

#### C. Marketplace feedback memory (best for public reputation)
Current candidates:
- `genome-hub.feedbackData`
- `score_agent` → `update_genome_feedback`

Use for:
- crowd score
- action recommendations
- public reviews / suggestions

### 8.3 Policy
- Memory writes must record **provenance**.
- Supervisor-generated memory should never silently overwrite human-authored guidance.
- Public marketplace memory must remain aggregate/anonymized.
- Genome-level learnings should roll forward through lineage only when explicitly promoted.

---

## 9. Help Agents system design

## 9.1 Trigger path
- Primary trigger: explicit `@mention` or `request_help`
- Secondary trigger: supervisor pending action
- Optional trigger: automatic routing on repeated blocker / repeated tool failures

## 9.2 Universal help request envelope

```ts
interface HelpRequestEnvelope {
    requestId: string;
    targetSessionId?: string;
    targetTaskId?: string;
    teamId: string;
    reason: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    whatTried?: string[];
    requestedOutcome?: string;
    evidence?: {
        teamLogCursor?: number;
        claudeSessionIds?: string[];
        codexSessionIds?: string[];
        files?: string[];
    };
}
```

## 9.3 Universal help-agent prompt contract
Every help agent should receive:
- the specific problem only
- strict scope boundaries
- evidence handles
- success criteria
- auto-retire rule

This matches the current seed help-agent role and should be implemented as a reusable prompt template, not duplicated ad hoc.

## 9.4 Voting mechanism
For non-trivial repair or design arbitration:
- spawn 2–3 helper opinions max
- normalize outputs into comparable proposals
- vote by weighted scoring:
  - evidence quality 40%
  - scope fit 25%
  - implementation risk 20%
  - speed 15%
- supervisor/master chooses the winning plan

Do **not** block normal low-severity fixes behind voting.

---

## 10. Supervisor enhancement design

## 10.1 Evidence sources
Supervisor should treat these as first-class streams:
1. team message log
2. Claude CC log
3. Codex global history (`~/.codex/history.jsonl`)
4. Codex session transcript files (`~/.codex/sessions/...`)
5. board/task state snapshots

## 10.2 Tooling gap to close
Current state persists Codex cursors, but the read tools are still Claude-oriented.

### Add / refactor tools
- `list_team_runtime_logs(teamId)` → unified mapping for Claude + Codex + runtime type
- `read_runtime_log(sessionId, runtimeType, fromCursor)` → runtime-aware reader
- keep `read_cc_log` as compatibility alias for Claude

### Why
This removes supervisor bias toward Claude and makes scoring evidence symmetrical across runtimes.

## 10.3 Cursor contract
Persist per team:
- `teamLogCursor`
- `claudeLogCursors[sessionId]`
- `codexHistoryCursor`
- `codexSessionCursors[sessionId]`

On each cycle:
1. verify previous predictions
2. read only unread tails
3. compute evidence-backed metrics
4. score
5. persist new cursors and predictions

## 10.4 Scoring display in Agent view / Market
Current Kanban marketplace already shows crowd score and counts.

Recommended additions:
- runtime badge (`claude` / `codex` / `open-code`)
- verification badge source (`official`, `verified`, `crowd-proven`, `experimental`)
- latest action recommendation (`keep`, `mutate`, etc.) on detail page
- model preference panel from runtime adapter
- recent proof-of-work / work history snippets

---

## 11. Launch-first implementation sequence

### Track A — schema foundation (Gene Schema Builder + Specialist)
1. Expand canonical schema in `aha-cli/src/api/types/genome.ts`
2. Mirror type in `genome-hub/src/types/genome.ts`
3. Mirror display subset in `kanban/sources/utils/genomeHub.ts`
4. Keep flat compatibility aliases during launch

### Track B — persistence / API
1. Extend `happy-server` create/patch routes to accept added metadata cleanly
2. Use existing DB columns for release/lineage where possible (`status`, `origin`, `variantOf`, `mutationNote`)
3. Put new deep fields inside `spec` first; avoid schema churn unless search/filter requires first-class DB columns
4. Only promote to DB columns if needed for market filters/ranking

### Track C — runtime adapters
1. Make Claude read adapter entry/runtime data from the new schema
2. Make Codex read adapter entry/runtime data from the new schema
3. Keep `buildGenomeInjection()` as shared deterministic compiler for memory/resume/governance context

### Track D — classification + memory
1. Add classification object under spec
2. Add provenance-aware memory profile
3. Implement hybrid persistence write/read policy
4. Keep marketplace feedback aggregate-only

### Track E — Help+Supervisor
1. Add unified help request envelope + prompt template
2. Add runtime-aware log reader for supervisor
3. Surface scoring and verification metadata in agent detail + market cards

---

## 12. Concrete file ownership / handoff map

### Gene Schema Builder / Specialist
Primary implementation files:
- `aha-cli/src/api/types/genome.ts`
- `genome-hub/src/types/genome.ts`
- `kanban/sources/utils/genomeHub.ts`
- `aha-cli/src/claude/utils/buildGenomeInjection.ts`
- `aha-cli/src/claude/runClaude.ts`
- `aha-cli/src/codex/runCodex.ts`

### Classification + memory implementer
Primary implementation files:
- `aha-cli/src/api/types/genome.ts`
- `genome-hub/src/types/genome.ts`
- any new local memory utilities under `aha-cli/src/claude/team` or `aha-cli/src/claude/utils`
- optional persistence glue in `happy-server` KV/team-context services

### Help+Supervisor implementer
Primary implementation files:
- `aha-cli/src/claude/utils/startAhaServer.ts`
- `aha-cli/src/daemon/supervisorState.ts`
- new runtime-log reader utilities under `aha-cli/src/daemon` or `aha-cli/src/claude/utils`
- `kanban/sources/app/(app)/agents/index.tsx`
- `kanban/sources/app/(app)/agents/[id].tsx`

---

## 13. Recommended launch stance

### P0 (must ship)
- layered schema with compatibility aliases
- runtime adapter support for Claude/Codex
- lineage/release/discovery/cost/failure metadata
- classification object
- provenance-aware memory profile
- runtime-aware supervisor evidence reading
- score/verification/runtime display in market/detail UI

### P1 (can follow right after launch)
- multi-helper voting UX
- adapter-specific hook execution policies
- richer public proof-of-work feeds
- full market-based team assembly flow

---

## 14. Short conclusion

The correct mental model is:

**Genome library = portable DNA + runtime adapters + memory policy + evidence resume + market profile.**

That split preserves launch speed while matching the real product:
- one genome can target multiple runtimes
- one resume can aggregate cross-runtime performance
- one market profile can be searched, trusted, and installed
- one lineage chain can explain how the agent evolved

