# GenomeSpec launch diff (5 fields only)

Date: 2026-03-18
Owner: solution-architect

Goal: unblock implementation without GenomeSpecV3 migration.

## A. Canonical rule
This sprint is **minimal additive change only**.
Do not introduce `GenomeSpecV3`, `runtime[]`, or a multi-layer breaking migration.

## B. Aha CLI canonical type diff
File: `aha-cli/src/api/types/genome.ts`

### 1) Add runtime label normalization
`genome-hub` and `kanban` already expose `runtimeType`; `aha-cli` should match.

```ts
runtimeType?: 'claude' | 'codex' | 'open-code';
```

### 2) Add the 5 missing fields
Paste these as new optional top-level fields in `GenomeSpec`:

```ts
trigger?: {
    mode: 'mention' | 'task-assign' | 'scheduled' | 'event';
    conditions?: string[];
};

provenance?: {
    parentId?: string;
    mutationNote?: string;
    origin?: 'original' | 'forked' | 'mutated';
};

evalCriteria?: string[];

costProfile?: {
    typicalTokens?: number;
    contextWindowReq?: number;
};

lifecycle?: 'experimental' | 'active' | 'deprecated';
```

### 3) Optional consistency cleanup
Current `contextInjections.trigger` in `aha-cli` is missing `'on_resume'`, while `genome-hub` and `kanban` already have it.
Minimal normalization is safe:

```ts
trigger: 'on_join' | 'per_tool_call' | 'on_context_threshold' | 'on_resume';
```

## C. Marketplace server type diff
File: `genome-hub/src/types/genome.ts`

Add the same 5 fields to `GenomeSpec` there as well:

```ts
trigger?: {
    mode: 'mention' | 'task-assign' | 'scheduled' | 'event';
    conditions?: string[];
};

provenance?: {
    parentId?: string;
    mutationNote?: string;
    origin?: 'original' | 'forked' | 'mutated';
};

evalCriteria?: string[];

costProfile?: {
    typicalTokens?: number;
    contextWindowReq?: number;
};

lifecycle?: 'experimental' | 'active' | 'deprecated';
```

## D. Kanban display type diff
File: `kanban/sources/utils/genomeHub.ts`

Add the same 5 fields to the UI `GenomeSpec` subset so cards/detail pages can render them later without type drift:

```ts
trigger?: {
    mode: 'mention' | 'task-assign' | 'scheduled' | 'event';
    conditions?: string[];
};

provenance?: {
    parentId?: string;
    mutationNote?: string;
    origin?: 'original' | 'forked' | 'mutated';
};

evalCriteria?: string[];

costProfile?: {
    typicalTokens?: number;
    contextWindowReq?: number;
};

lifecycle?: 'experimental' | 'active' | 'deprecated';
```

## E. Prisma diff (genome-hub only)
File: `genome-hub/prisma/schema.prisma`

Only `lifecycle` needs a dedicated DB column for launch filtering. The other 4 fields can stay inside `spec` JSON.

```prisma
model Genome {
    id            String   @id @default(cuid())
    namespace     String?
    name          String
    version       Int      @default(1)
    description   String?
    spec          String
    tags          String?
    category      String?
    lifecycle     String?  // experimental | active | deprecated
    isPublic      Boolean  @default(true)
    spawnCount    Int      @default(0)
    downloadCount Int      @default(0) @map("download_count")
    starCount     Int      @default(0) @map("star_count")
    publisherId   String?
    feedbackData  String?
    parentId      String?
    createdAt     DateTime @default(now())
    updatedAt     DateTime @updatedAt
    favorites     GenomeFavorite[]

    @@unique([namespace, name, version])
    @@index([namespace])
    @@index([category])
    @@index([lifecycle])
    @@index([isPublic])
    @@index([parentId])
}
```

## F. Runtime adapter minimal change recommendation
Do **not** add `runtime[]` now.
Launch-safe runtime guidance is just:
1. add `runtimeType` to `aha-cli` canonical type
2. keep existing `runClaude.ts` / `runCodex.ts` flow unchanged
3. continue storing deeper runtime-specific data in existing fields (`hooks`, `skills`, `mcpServers`, `allowedTools`, `disallowedTools`, `permissionMode`)

## G. Storage rule
- `trigger`, `evalCriteria`, `costProfile` -> stay in `spec` JSON only
- `provenance.parentId` -> mirrors existing DB `parentId`; `mutationNote/origin` already exist in other storage layers, keep spec-level copy for portable DNA
- `lifecycle` -> store in both `spec` and `genome-hub` Prisma column for filtering

## H. TDD order
1. RED: type/parse tests for 5 new fields
2. GREEN: add fields to 3 TypeScript interfaces
3. RED: persistence/filter test for `lifecycle`
4. GREEN: add Prisma + storage plumbing
5. REFACTOR: remove any duplicate ad-hoc literals

