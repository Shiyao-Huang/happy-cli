# Launch Contract: Agent Docker / Workspace CRUD / Marketplace Team Templates

Date: 2026-03-18
Owner: solution-architect
Scope: `aha-cli` + `happy-server` + `genome-hub` + `kanban`

## 1. Current-state findings

### 1.1 Genome / package state already exists
- Runtime-canonical `GenomeSpec` lives in `aha-cli/src/api/types/genome.ts`.
- Public marketplace type mirror lives in `genome-hub/src/types/genome.ts`.
- UI subset lives in `kanban/sources/utils/genomeHub.ts`.
- Private/local genome persistence lives in `happy-server` `Genome` table (`happy-server/prisma/schema.prisma`).
- Public published genome persistence, stars/favorites, downloads, promotion, fork/clone, and requirement search already live in `genome-hub/src/routes/genomeRoutes.ts`.

### 1.2 Standalone agent support already exists
- `happy-server/sources/app/api/routes/agentRoutes.ts` already implements:
  - `POST /v1/agents`
  - `GET /v1/agents`
  - `GET /v1/agents/:id`
  - `PATCH /v1/agents/:id`
  - `DELETE /v1/agents/:id`
  - `POST /v1/agents/:id/promote`
- Important: the current standalone agent is **not** a first-class DB model. It is an **Artifact-backed team projection with one member**.

### 1.3 Marketplace team-template groundwork already exists
- `genome-hub` already ships:
  - `/genomes/from-requirement` with `auto | semi-auto | manual`
  - `/corps` convenience routes
  - favorites/star endpoints
- `kanban` already renders marketplace genomes + corps/team-template cards in `sources/app/(app)/agents/*`.

### 1.4 Workspace is still implicit, not modeled
- Today, working directory is mostly passed around as raw `directory` / `sessionPath`.
- Team creation in `kanban/sources/app/(app)/teams/new.tsx` and agent spawning in `aha-cli` already depend on directory selection.
- UI uses the word “workspace”, but there is no first-class `Workspace` API/resource yet.

---

## 2. Launch architecture decisions

## Decision A — “Agent Docker” is a product concept, not a big launch migration

For launch, use this mapping:

- **GenomeSpec** = Dockerfile
- **Genome record** = image record
- **`@ns/name:version` / `specId`** = image reference
- **running session** = container
- **`fetchGenomeSpec()` cache** = local pull cache
- **marketplace publish/promote** = image registry workflow

### Launch rule
Do **not** introduce a breaking `GenomeSpecV3` or a mandatory `runtime[]` adapter array in this sprint.

### Launch-safe Genome Schema v2
Keep the existing flat schema and add only the missing launch metadata:
- `runtimeType`
- `trigger`
- `provenance`
- `evalCriteria`
- `costProfile`
- `lifecycle`

Also normalize:
- `contextInjections.trigger` should include `'on_resume'`

This matches the current launch docs and avoids a flag-day rewrite across 4 codebases.

### North-star after launch
After launch, we can promote a richer package layer (`digest`, env contract, runtime adapters, install contract), but that should be a follow-up track, not a prerequisite for shipping.

---

## Decision B — Keep Agent as an Artifact-backed projection for launch

Do **not** add a new `Agent` database table yet.

Why:
- standalone CRUD already works
- promotion to team already works
- current data shape is compatible with existing team/artifact flows
- introducing a new agent table now would duplicate lifecycle state and slow the launch

### Launch contract
- **Standalone agent** remains `Artifact(type='standalone') + one team member + one session`
- **Team agent** remains `Artifact(type='team') + N members + N sessions`
- `genomeId` remains the reusable package pointer
- `sessionId` remains the runtime instance pointer

### Required launch extension
Add `workspaceId` support to standalone agents and team members, but store it as a reference in board/member metadata first.

---

## Decision C — Introduce Workspace as the new first-class resource

This is the main missing launch object.

### Why Workspace must exist
Right now the system confuses:
- repo/directory identity
- machine binding
- default launch path
- team/agent runtime location

A first-class `Workspace` should answer:
- which machine?
- which root path?
- which repo?
- which default template/genome should start here?

### Proposed `Workspace` model (happy-server)

```ts
interface Workspace {
  id: string;
  accountId: string;
  machineId?: string | null;
  name: string;
  rootPath: string;
  normalizedPath: string;
  repoRoot?: string | null;
  repoName?: string | null;
  repoRemoteUrl?: string | null;
  defaultBranch?: string | null;
  metadata?: string | null;      // JSON
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}
```

### Minimal Workspace CRUD

```http
POST   /v1/workspaces
GET    /v1/workspaces
GET    /v1/workspaces/:id
PATCH  /v1/workspaces/:id
DELETE /v1/workspaces/:id        # soft archive
```

### Request/response rules
- `rootPath` is required on create.
- `machineId` is optional but strongly recommended.
- server stores both raw path and normalized path for de-dupe.
- delete should archive, not hard-delete.

### Launch integration points
1. `POST /v1/agents` accepts `workspaceId`
2. `POST /v1/teams` accepts `workspaceId`
3. board metadata stores both:
   - canonical `workspaceId`
   - snapshot fallback: `machineId`, `rootPath`

This preserves resilience when workspace metadata changes later.

---

## Decision D — Team Templates should reuse existing CorpsSpec

Do **not** invent a second marketplace template object for launch.

Use:
- `category = 'corps'`
- `spec = CorpsSpec`

But in product/UI language, present these as:
- **Team Templates**

### Why
`genome-hub` already has:
- corps routes
- corps parsing
- corps cards in kanban

The missing piece is not storage — it is **instantiation flow**.

### Required launch contract
Add one server-side instantiation endpoint:

```http
POST /v1/teams/from-template
```

Body:

```ts
{
  templateGenomeId: string;      // corps genome id
  workspaceId?: string;
  name?: string;
  runtimePreference?: 'claude' | 'codex' | 'mixed';
  spawnAgents?: boolean;         // default true
}
```

Response:

```ts
{
  team: { id: string; name: string; ... };
  template: { id: string; name: string; version: number };
  plannedMembers: Array<{
    role: string;
    genomeRef: string;
    required: boolean;
    count: number;
  }>;
}
```

### Launch behavior
- server resolves template from `genome-hub` or mirrored local data
- creates the team artifact
- stores template provenance in team metadata
- optionally spawns members using existing team/member spawn flow

### UI behavior
- `kanban` “Agents / Corps” page becomes the source for browsing templates
- `Create Team` flow adds “Use Team Template”
- after template selection, user chooses workspace + machine + runtime preference

---

## Decision E — Stars/Favorites stay in genome-hub; happy-server is not the score brain

Keep this split:

- `genome-hub`
  - public package registry
  - favorites / star count
  - download count
  - aggregate feedback / score projection
  - corps/team-template discovery

- `happy-server`
  - authenticated relay
  - private draft genomes
  - local mutations / publish handoff
  - workspace / team / standalone-agent control plane

This is already the direction implied by:
- `genome-hub` favorite/star/download endpoints
- `happy-server` `hubGenomeId` field
- current publish flow in `evolutionRoutes.ts`

---

## 2.5 Launch ownership summary

Launch should **not** force a single Genome table.

Instead, keep the ownership split lightweight and explicit:

1. `genome-hub` owns the **public marketplace projection**:
   - favorites / stars / downloads
   - public feedback projection
   - public lineage / discovery-facing data
2. `happy-server` owns the **private draft + control-plane state**:
   - account / team / session scope
   - `hubGenomeId` linkage
   - private derivation history
   - soft delete and workflow state
3. `hubGenomeId` + publish flow is the bridge between the two systems.
4. `status` remains intentionally split in launch:
   - hub = public projection status
   - happy-server = private workflow status
5. `lifecycle` is not a hard launch dependency unless hub API/UI/filter wiring is completed end to end.

---

## 3. Concrete launch contracts by surface

## 3.1 `aha-cli`

### Required
- keep `GenomeSpec` as canonical TS runtime-facing type
- add/normalize the minimal v2 fields
- keep `fetchGenomeSpec()` resolving:
  - UUID
  - `@ns/name`
  - `@ns/name:version`

### Optional later
- package digest
- richer env/install contract
- multi-runtime adapter arrays

## 3.2 `happy-server`

### Required
- new `Workspace` model + CRUD routes
- extend `POST /v1/agents` to accept `workspaceId`
- extend `POST /v1/teams` to accept `workspaceId`
- add `POST /v1/teams/from-template`
- keep standalone agent backed by Artifact

### Non-goal for launch
- new standalone `Agent` table
- duplicating market score/favorite data locally

## 3.3 `genome-hub`

### Required
- keep favorites/star/download/fork/clone/from-requirement/corps flows
- support template lookup for team instantiation
- continue public score aggregation only

### Nice-to-have
- template-specific ranking signal
- “used by N teams” counter separate from spawn count

## 3.4 `kanban`

### Required
- add workspace CRUD UI
- allow agent creation from:
  - genome
  - runtime-only quick create
  - workspace-bound launch
- add “Use Team Template” path in team creation
- keep corps tab but relabel surfaced copy as Team Templates where product-facing

---

## 4. Recommended implementation order

## P0
1. Minimal Genome Schema v2 delta only
2. Workspace Prisma model + CRUD
3. `workspaceId` plumbing into team + agent creation
4. `POST /v1/teams/from-template`
5. Kanban template-instantiation flow

## P1
1. richer package/install metadata (`digest`, env contract)
2. better template ranking signals
3. workspace activity history / recent launches
4. package-level verification badges beyond current score projection

---

## 5. Short conclusion

Launch should be built around **three stable objects**:

1. **Genome package** — reusable agent DNA
2. **Workspace** — machine + repo + root-path binding
3. **Artifact-backed runtime projection** — standalone agent or team instance

That means:
- keep Genome Schema v2 minimal
- keep standalone agent implementation lightweight
- make Workspace the missing first-class control-plane object
- reuse existing CorpsSpec as Team Templates instead of inventing another schema
