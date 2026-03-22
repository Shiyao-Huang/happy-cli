import { z } from 'zod'

export const reflexivityDimensionSchema = z.enum([
    'identity',
    'environment',
    'tools',
    'boundaries',
    'task_type',
    'self_eval',
    'limitation',
    'consistency',
])
export type ReflexivityDimension = z.infer<typeof reflexivityDimensionSchema>

export const interactionModeSchema = z.enum(['single_turn', 'multi_turn'])
export type InteractionMode = z.infer<typeof interactionModeSchema>

export const claimMatchModeSchema = z.enum([
    'exact',
    'contains',
    'set-overlap',
    'regex',
    'enum',
    'contains-any',
    'enum-or-overlap',
    'asserted',
])
export type ClaimMatchMode = z.infer<typeof claimMatchModeSchema>

export const claimSourceSchema = z.enum([
    'self_view',
    'team_info',
    'team_config',
    'task_state',
    'system_md',
    'spawn_context',
    'runtime_probe',
    'artifact_context',
    'permissions',
    'reasoning',
])
export type ClaimSource = z.infer<typeof claimSourceSchema>

export const expectedClaimSchema = z.object({
    claimType: z.string().min(1),
    subject: z.string().optional(),
    expectedValueFrom: z.string().min(1).optional(),
    expectedValue: z.union([z.string(), z.array(z.string()), z.boolean()]).optional(),
    matchMode: claimMatchModeSchema,
    required: z.boolean(),
    source: claimSourceSchema,
    creditOnUnknown: z.boolean().optional().default(false),
})
export type ExpectedClaim = z.infer<typeof expectedClaimSchema>

export const forbiddenClaimSchema = z.object({
    claimType: z.string().min(1),
    subject: z.string().optional(),
    when: z.string().min(1).optional(),
    reason: z.string().min(1),
})
export type ForbiddenClaim = z.infer<typeof forbiddenClaimSchema>

export const consistencyCheckPolicySchema = z.enum([
    'stable_across_turns',
    'stable_or_explicitly_corrected',
    'may_expand_but_not_disappear_without_evidence',
])
export type ConsistencyCheckPolicy = z.infer<typeof consistencyCheckPolicySchema>

export const consistencyCheckSchema = z.object({
    subject: z.string().min(1),
    policy: consistencyCheckPolicySchema,
})
export type ConsistencyCheck = z.infer<typeof consistencyCheckSchema>

export const scoringWeightsSchema = z.object({
    accuracy: z.number().nonnegative(),
    completeness: z.number().nonnegative(),
    honesty: z.number().nonnegative(),
    consistency: z.number().nonnegative().optional(),
})
export type ScoringWeights = z.infer<typeof scoringWeightsSchema>

export const scoringPolicySchema = z.object({
    weights: scoringWeightsSchema,
    hallucinationPenalty: z.number().nonnegative(),
    omissionPenalty: z.number().nonnegative().optional().default(0),
    contradictionPenalty: z.number().nonnegative().optional().default(0),
    unknownButHonestBonus: z.number().nonnegative().optional().default(0),
    sourceAttributionBonus: z.number().nonnegative().optional().default(0),
    criticalClaims: z.array(z.string()).optional().default([]),
    passThreshold: z.number().min(0).max(100),
})
export type ScoringPolicy = z.infer<typeof scoringPolicySchema>

export const fixtureRequirementsSchema = z.object({
    snapshotSections: z.array(z.string()).default([]),
    tooling: z.array(z.string()).default([]),
    preconditions: z.array(z.string()).default([]),
    optionalSections: z.array(z.string()).optional().default([]),
})
export type FixtureRequirements = z.infer<typeof fixtureRequirementsSchema>

export const reflexivityCaseSchema = z.object({
    schemaVersion: z.literal('reflexivity-case-v1'),
    caseId: z.string().min(1),
    title: z.string().min(1),
    dimension: reflexivityDimensionSchema,
    interactionMode: interactionModeSchema,
    prompts: z.array(z.string().min(1)).min(1),
    fixtureRequirements: fixtureRequirementsSchema,
    expectedClaims: z.array(expectedClaimSchema).min(1),
    forbiddenClaims: z.array(forbiddenClaimSchema).optional().default([]),
    consistencyChecks: z.array(consistencyCheckSchema).optional().default([]),
    scoring: scoringPolicySchema,
    notes: z.string().optional(),
})
export type ReflexivityCase = z.infer<typeof reflexivityCaseSchema>

export const toolAccessModeSchema = z.enum([
    'allowed',
    'permission_denied',
    'precondition_required',
    'unknown',
])
export type ToolAccessMode = z.infer<typeof toolAccessModeSchema>

export const toolProbeStatusSchema = z.enum([
    'ok',
    'failed',
    'unavailable',
    'permission_denied',
    'not_probed',
])
export type ToolProbeStatus = z.infer<typeof toolProbeStatusSchema>

export const confidenceSchema = z.enum(['high', 'medium', 'low'])
export type ConfidenceLevel = z.infer<typeof confidenceSchema>

export const sourceRefSchema = z.object({
    source: z.string().min(1),
    collectedAt: z.number().int().nonnegative().optional(),
    confidence: confidenceSchema.optional().default('medium'),
    rawRef: z.string().optional(),
})
export type SourceRef = z.infer<typeof sourceRefSchema>

export const identitySnapshotSchema = z.object({
    sessionId: z.string().nullable().default(null),
    role: z.string().nullable().default(null),
    genomeName: z.string().nullable().default(null),
    genomeDescription: z.string().nullable().default(null),
    specId: z.string().nullable().default(null),
    teamId: z.string().nullable().default(null),
    teamName: z.string().nullable().default(null),
    runtimeType: z.string().nullable().default(null),
    responsibilities: z.array(z.string()).default([]),
    sources: z.record(sourceRefSchema).optional().default({}),
})
export type IdentitySnapshot = z.infer<typeof identitySnapshotSchema>

export const taskSnapshotSchema = z.object({
    primary: z.object({
        taskId: z.string().nullable().default(null),
        title: z.string().nullable().default(null),
        status: z.string().nullable().default(null),
        priority: z.string().nullable().default(null),
        taskType: z.string().nullable().default(null),
        inputs: z.array(z.string()).default([]),
        outputs: z.array(z.string()).default([]),
        acceptanceCriteria: z.array(z.string()).default([]),
        currentSlice: z.string().nullable().default(null),
        nextAction: z.string().nullable().default(null),
    }).nullable().default(null),
    allVisibleTasks: z.array(z.object({
        taskId: z.string(),
        title: z.string(),
        status: z.string().nullable().optional(),
        priority: z.string().nullable().optional(),
    })).default([]),
})
export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>

export const environmentSnapshotSchema = z.object({
    cwd: z.string().nullable().default(null),
    guidanceFiles: z.array(z.string()).default([]),
    hostCapabilities: z.array(z.string()).default([]),
    blindSpots: z.array(z.string()).default([]),
    requiresProbe: z.array(z.string()).default([]),
})
export type EnvironmentSnapshot = z.infer<typeof environmentSnapshotSchema>

export const toolStateSchema = z.object({
    declaredAvailable: z.boolean().default(false),
    declaredSource: z.string().min(1).default('case_fixture'),
    accessMode: toolAccessModeSchema.default('unknown'),
    status: toolProbeStatusSchema.default('not_probed'),
    value: z.unknown().nullable().optional().default(null),
    error: z.string().nullable().optional().default(null),
    probedAt: z.number().int().nonnegative().optional(),
    rawRef: z.string().optional(),
})
export type ToolState = z.infer<typeof toolStateSchema>

export const toolSnapshotSchema = z.object({
    tools: z.record(toolStateSchema).default({}),
})
export type ToolSnapshot = z.infer<typeof toolSnapshotSchema>

export const boundarySnapshotSchema = z.object({
    readFirst: z.array(z.string()).default([]),
    primaryWriteScope: z.string().nullable().default(null),
    avoidScopes: z.array(z.string()).default([]),
    readOnlyDocs: z.array(z.string()).default([]),
    helpLane: z.array(z.string()).default([]),
    contextMirrorRule: z.string().nullable().default(null),
    compactRule: z.string().nullable().default(null),
    rawSpawnContext: z.string().nullable().default(null),
})
export type BoundarySnapshot = z.infer<typeof boundarySnapshotSchema>

export const limitationsSnapshotSchema = z.object({
    active: z.array(z.string()).default([]),
    needsEvidence: z.array(z.string()).default([]),
    unblockOptions: z.array(z.string()).default([]),
    derivedFrom: z.array(z.string()).default([]),
})
export type LimitationsSnapshot = z.infer<typeof limitationsSnapshotSchema>

export const artifactSnapshotSchema = z.object({
    completedItems: z.array(z.string()).default([]),
    remainingItems: z.array(z.string()).default([]),
    reviewRisks: z.array(z.string()).default([]),
    evidenceRefs: z.array(z.string()).default([]),
    expectedConfidenceBand: z.string().nullable().default(null),
})
export type ArtifactSnapshot = z.infer<typeof artifactSnapshotSchema>

export const collectionLogEntrySchema = z.object({
    step: z.string().min(1),
    status: z.enum(['ok', 'failed', 'fallback', 'conflict', 'info']),
    message: z.string().min(1),
    recordedAt: z.number().int().nonnegative(),
})
export type CollectionLogEntry = z.infer<typeof collectionLogEntrySchema>

export const reflexivityFixtureSchema = z.object({
    schemaVersion: z.literal('reflexivity-fixture-v1'),
    fixtureId: z.string().min(1),
    collectedAt: z.number().int().nonnegative(),
    context: z.object({
        teamId: z.string().nullable().default(null),
        sessionId: z.string().nullable().default(null),
        runtimeType: z.string().nullable().default(null),
    }),
    identitySnapshot: identitySnapshotSchema.default({}),
    taskSnapshot: taskSnapshotSchema.default({ allVisibleTasks: [] }),
    environmentSnapshot: environmentSnapshotSchema.default({}),
    toolSnapshot: toolSnapshotSchema.default({}),
    boundarySnapshot: boundarySnapshotSchema.default({}),
    limitationsSnapshot: limitationsSnapshotSchema.default({}),
    artifactSnapshot: artifactSnapshotSchema.default({}),
    collectionLog: z.array(collectionLogEntrySchema).default([]),
})
export type ReflexivityFixture = z.infer<typeof reflexivityFixtureSchema>

export const extractedClaimStatusSchema = z.enum([
    'known',
    'unknown',
    'error',
    'permission_denied',
    'corrected',
])
export type ExtractedClaimStatus = z.infer<typeof extractedClaimStatusSchema>

export const extractedClaimSchema = z.object({
    claimType: z.string().min(1),
    subject: z.string().optional(),
    value: z.union([z.string(), z.array(z.string()), z.boolean()]).optional(),
    status: extractedClaimStatusSchema.default('known'),
    source: z.string().optional(),
    justification: z.string().optional(),
})
export type ExtractedClaim = z.infer<typeof extractedClaimSchema>

export const structuredTurnAnswerSchema = z.object({
    answer: z.string().default(''),
    claims: z.array(extractedClaimSchema).default([]),
    unknowns: z.array(z.string()).optional().default([]),
    limitations: z.array(z.string()).optional().default([]),
    corrections: z.array(z.string()).optional().default([]),
    confidence: confidenceSchema.optional(),
})
export type StructuredTurnAnswer = z.infer<typeof structuredTurnAnswerSchema>

export const promptTurnResultSchema = z.object({
    prompt: z.string(),
    augmentedPrompt: z.string(),
    rawResponse: z.string(),
    parsed: structuredTurnAnswerSchema.nullable().default(null),
    parsingError: z.string().nullable().default(null),
    turnIndex: z.number().int().nonnegative(),
})
export type PromptTurnResult = z.infer<typeof promptTurnResultSchema>

export const claimEvaluationStatusSchema = z.enum([
    'matched',
    'honest_unknown',
    'wrong',
    'missing',
    'forbidden_violation',
    'not_applicable',
])
export type ClaimEvaluationStatus = z.infer<typeof claimEvaluationStatusSchema>

export const claimEvaluationSchema = z.object({
    claimType: z.string(),
    subject: z.string().optional(),
    status: claimEvaluationStatusSchema,
    expectedValue: z.union([z.string(), z.array(z.string()), z.boolean(), z.null()]).optional(),
    observedValue: z.union([z.string(), z.array(z.string()), z.boolean(), z.null()]).optional(),
    reason: z.string(),
    required: z.boolean().default(false),
    source: claimSourceSchema.optional(),
    turnIndex: z.number().int().nonnegative().optional(),
})
export type ClaimEvaluation = z.infer<typeof claimEvaluationSchema>

export const consistencyCheckResultSchema = z.object({
    subject: z.string(),
    policy: consistencyCheckPolicySchema,
    passed: z.boolean(),
    reason: z.string(),
})
export type ConsistencyCheckResult = z.infer<typeof consistencyCheckResultSchema>

export const scoreBreakdownSchema = z.object({
    accuracyScore: z.number().nonnegative(),
    completenessScore: z.number().nonnegative(),
    honestyScore: z.number().nonnegative(),
    consistencyScore: z.number().nonnegative().default(0),
    totalScore: z.number().nonnegative(),
    maxScore: z.number().positive(),
    passed: z.boolean(),
    matchedCount: z.number().int().nonnegative(),
    honestUnknownCount: z.number().int().nonnegative(),
    wrongCount: z.number().int().nonnegative(),
    missingCount: z.number().int().nonnegative(),
    forbiddenViolationCount: z.number().int().nonnegative(),
    sourceAttributedCount: z.number().int().nonnegative(),
})
export type ScoreBreakdown = z.infer<typeof scoreBreakdownSchema>

export const reflexivityCaseResultSchema = z.object({
    caseId: z.string(),
    title: z.string(),
    dimension: reflexivityDimensionSchema,
    fixture: reflexivityFixtureSchema,
    turns: z.array(promptTurnResultSchema),
    claimEvaluations: z.array(claimEvaluationSchema),
    forbiddenEvaluations: z.array(claimEvaluationSchema).default([]),
    consistencyChecks: z.array(consistencyCheckResultSchema).default([]),
    score: scoreBreakdownSchema,
    notes: z.array(z.string()).default([]),
})
export type ReflexivityCaseResult = z.infer<typeof reflexivityCaseResultSchema>

export const reflexivityRunReportSchema = z.object({
    generatedAt: z.number().int().nonnegative(),
    caseResults: z.array(reflexivityCaseResultSchema),
    summary: z.object({
        totalCases: z.number().int().nonnegative(),
        passedCases: z.number().int().nonnegative(),
        failedCases: z.number().int().nonnegative(),
        averageScore: z.number().nonnegative(),
    }),
})
export type ReflexivityRunReport = z.infer<typeof reflexivityRunReportSchema>
