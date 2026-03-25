/**
 * @module mirrorTypes
 * @description Type definitions for the Mirror Recursion Feedback Loop.
 *
 * The Mirror system enables agents to observe their own behavior,
 * analyze gaps between genome spec and actual performance, propose
 * genome mutations, and verify improvements — with convergence
 * detection and recursion safety.
 */

// ─── Observation Layer ──────────────────────────────────────────────────────

/** A single gap between what the genome spec says and what the agent actually did. */
export interface MirrorObservation {
    /** What kind of gap this is */
    type: 'violation' | 'missing' | 'exceeded' | 'good';
    /** Which genome spec field is involved, e.g. "protocol[2]" or "responsibility[0]" */
    target: string;
    /** Evidence from CC log or behavior that proves this observation */
    evidence: string;
    /** How impactful this gap is */
    severity: 'low' | 'medium' | 'high';
}

/** Raw data collected during the OBSERVE step */
export interface MirrorObservationData {
    /** Session being observed */
    sessionId: string;
    /** Genome spec used for comparison */
    genomeNamespace: string;
    genomeName: string;
    genomeVersion: number;
    /** Current average score */
    avgScore: number;
    /** Score dimension breakdown */
    dimensions: {
        delivery: number;
        integrity: number;
        efficiency: number;
        collaboration: number;
        reliability: number;
    };
    /** Latest action from feedback */
    latestAction: 'keep' | 'keep_with_guardrails' | 'mutate' | 'discard';
    /** Existing suggestions from feedback */
    suggestions: string[];
    /** Number of evaluations aggregated */
    evaluationCount: number;
    /** Existing learnings in genome memory */
    existingLearnings: string[];
}

// ─── Analysis Layer ─────────────────────────────────────────────────────────

/** Result of analyzing observations to produce mutation proposals */
export interface MirrorAnalysis {
    /** Structured observations from spec-vs-behavior comparison */
    observations: MirrorObservation[];
    /** Synthesized learnings to merge into genome memory */
    proposedLearnings: string[];
    /** Summary of the analysis */
    summary: string;
    /** Whether the analysis suggests evolution is warranted */
    shouldEvolve: boolean;
    /** Reason if evolution is not warranted */
    skipReason?: string;
}

// ─── Convergence Layer ──────────────────────────────────────────────────────

/** Tracks convergence state across mirror iterations */
export interface ConvergenceState {
    /** Current iteration depth (0-indexed) */
    depth: number;
    /** Maximum allowed depth */
    maxDepth: number;
    /** Score history across iterations: [preScore, postScore, ...] */
    scoreHistory: number[];
    /** Whether convergence has been reached */
    converged: boolean;
    /** Reason convergence was declared */
    convergenceReason?: string;
}

/** Criteria for determining convergence */
export interface ConvergenceCriteria {
    /** Score improvement below this between consecutive versions = converged */
    scoreThreshold: number;
    /** Minimum dimension score to consider "good enough" */
    minDimensionScore: number;
    /** Number of consecutive low-improvement iterations before declaring convergence */
    stagnationWindow: number;
}

// ─── Cycle Result ───────────────────────────────────────────────────────────

/** Result of a single mirror cycle iteration */
export interface MirrorIterationResult {
    /** Iteration index (0-based) */
    iteration: number;
    /** Observation data collected */
    observationData: MirrorObservationData;
    /** Analysis result */
    analysis: MirrorAnalysis;
    /** Whether evolution was attempted */
    evolved: boolean;
    /** New genome version if evolved, null if skipped */
    newVersion: number | null;
    /** Post-evolution score (null if not yet evaluated) */
    postScore: number | null;
}

/** Full result of a mirror_cycle invocation */
export interface MirrorCycleResult {
    /** Target session */
    sessionId: string;
    /** Genome identity */
    genomeNamespace: string;
    genomeName: string;
    /** All iteration results */
    iterations: MirrorIterationResult[];
    /** Final convergence state */
    convergence: ConvergenceState;
    /** Whether this was a dry run (no actual evolution) */
    dryRun: boolean;
    /** Overall summary */
    summary: string;
}

// ─── Safety ─────────────────────────────────────────────────────────────────

/** Safety configuration for the mirror cycle */
export interface MirrorSafetyConfig {
    /** Hard cap on recursion depth. Default 3, max 5. */
    maxDepth: number;
    /** Minimum evaluations required before allowing mirror cycle */
    minEvaluations: number;
    /** Minimum avgScore required for evolution (inherited from evolve_genome) */
    minPromoteScore: number;
    /** Convergence detection criteria */
    convergence: ConvergenceCriteria;
}

/** Default safety configuration */
export const DEFAULT_MIRROR_SAFETY: MirrorSafetyConfig = {
    maxDepth: 3,
    minEvaluations: 3,
    minPromoteScore: 60,
    convergence: {
        scoreThreshold: 2.0,
        minDimensionScore: 70,
        stagnationWindow: 2,
    },
};
