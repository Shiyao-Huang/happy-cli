/**
 * @module mirrorAnalysis
 * @description Pure functions for the Mirror feedback loop: observation,
 * analysis, and convergence detection.
 *
 * These functions are side-effect-free and operate on data structures
 * rather than making API calls. The tool layer (mirrorTools.ts) handles
 * all I/O and orchestration.
 */

import type {
    MirrorObservation,
    MirrorObservationData,
    MirrorAnalysis,
    ConvergenceState,
    ConvergenceCriteria,
    MirrorSafetyConfig,
} from './mirrorTypes';
import { DEFAULT_MIRROR_SAFETY } from './mirrorTypes';

// ─── Observation Analysis ───────────────────────────────────────────────────

/**
 * Analyze observation data to produce structured gaps and proposed learnings.
 *
 * Compares the genome's stated spec (responsibilities, protocol, capabilities)
 * against the feedback data (scores, suggestions, latestAction) to identify
 * actionable improvement areas.
 */
export function analyzeObservations(data: MirrorObservationData): MirrorAnalysis {
    const observations: MirrorObservation[] = [];
    const proposedLearnings: string[] = [];

    // 1. Analyze dimension weaknesses
    const dimensionEntries = Object.entries(data.dimensions) as Array<[string, number]>;
    for (const [dimension, score] of dimensionEntries) {
        if (score < 50) {
            observations.push({
                type: 'violation',
                target: `dimension.${dimension}`,
                evidence: `Score ${Math.round(score)}/100 is critically low`,
                severity: 'high',
            });
            proposedLearnings.push(
                `Critical improvement needed in ${dimension} (scored ${Math.round(score)}/100). ` +
                `Focus on behaviors that directly impact ${dimension} score.`
            );
        } else if (score < 70) {
            observations.push({
                type: 'missing',
                target: `dimension.${dimension}`,
                evidence: `Score ${Math.round(score)}/100 is below threshold`,
                severity: 'medium',
            });
            proposedLearnings.push(
                `Improve ${dimension} (scored ${Math.round(score)}/100) by consistently ` +
                `demonstrating ${dimension}-related behaviors in every task cycle.`
            );
        } else if (score >= 90) {
            observations.push({
                type: 'good',
                target: `dimension.${dimension}`,
                evidence: `Score ${Math.round(score)}/100 is excellent`,
                severity: 'low',
            });
        }
    }

    // 2. Analyze feedback suggestions (from supervisor evaluations)
    for (const suggestion of data.suggestions.slice(0, 5)) {
        if (suggestion.length > 10) {
            observations.push({
                type: 'missing',
                target: 'feedback.suggestion',
                evidence: suggestion,
                severity: 'medium',
            });
            // Only add as learning if not already covered by existing learnings
            const isDuplicate = data.existingLearnings.some(
                (existing) => existing.toLowerCase().includes(suggestion.toLowerCase().slice(0, 30))
            );
            if (!isDuplicate) {
                proposedLearnings.push(suggestion);
            }
        }
    }

    // 3. Check latestAction alignment
    if (data.latestAction === 'discard') {
        observations.push({
            type: 'violation',
            target: 'feedback.latestAction',
            evidence: `Latest evaluation recommended DISCARD — genome is fundamentally misaligned`,
            severity: 'high',
        });
    } else if (data.latestAction === 'mutate') {
        observations.push({
            type: 'missing',
            target: 'feedback.latestAction',
            evidence: `Latest evaluation recommended MUTATE — genome needs significant changes`,
            severity: 'medium',
        });
    }

    // 4. Determine if evolution is warranted
    const hasHighSeverity = observations.some((o) => o.severity === 'high');
    const hasMediumSeverity = observations.some((o) => o.severity === 'medium');
    const allDimensionsAboveThreshold = dimensionEntries.every(([, score]) => score >= 70);
    const isKeep = data.latestAction === 'keep';

    let shouldEvolve = false;
    let skipReason: string | undefined;

    if (data.evaluationCount < DEFAULT_MIRROR_SAFETY.minEvaluations) {
        skipReason = `Insufficient evaluations (${data.evaluationCount} < ${DEFAULT_MIRROR_SAFETY.minEvaluations}). Need more data before evolving.`;
    } else if (proposedLearnings.length === 0) {
        skipReason = 'No new learnings to propose. All observations are already covered by existing learnings.';
    } else if (isKeep && allDimensionsAboveThreshold && !hasHighSeverity) {
        skipReason = 'Genome is performing well (keep action, all dimensions ≥ 70, no critical issues).';
    } else {
        shouldEvolve = true;
    }

    // 5. Build summary
    const violationCount = observations.filter((o) => o.type === 'violation').length;
    const missingCount = observations.filter((o) => o.type === 'missing').length;
    const goodCount = observations.filter((o) => o.type === 'good').length;
    const summary = [
        `Mirror analysis for ${data.genomeNamespace}/${data.genomeName} v${data.genomeVersion}:`,
        `avgScore=${Math.round(data.avgScore)}, evaluations=${data.evaluationCount}, action=${data.latestAction}`,
        `Observations: ${violationCount} violations, ${missingCount} missing, ${goodCount} good`,
        `Proposed learnings: ${proposedLearnings.length} (existing: ${data.existingLearnings.length})`,
        shouldEvolve ? 'Decision: EVOLVE' : `Decision: SKIP — ${skipReason}`,
    ].join('\n');

    return {
        observations,
        proposedLearnings: deduplicateLearnings(proposedLearnings, data.existingLearnings),
        summary,
        shouldEvolve,
        skipReason,
    };
}

// ─── Convergence Detection ──────────────────────────────────────────────────

/**
 * Check if the mirror loop has converged based on score history
 * and convergence criteria.
 */
export function checkConvergence(
    scoreHistory: number[],
    criteria: ConvergenceCriteria,
    currentDepth: number,
    maxDepth: number,
): ConvergenceState {
    const state: ConvergenceState = {
        depth: currentDepth,
        maxDepth,
        scoreHistory: [...scoreHistory],
        converged: false,
    };

    // Safety: max depth reached
    if (currentDepth >= maxDepth) {
        return {
            ...state,
            converged: true,
            convergenceReason: `Maximum depth reached (${currentDepth}/${maxDepth})`,
        };
    }

    // Need at least 2 scores to compare
    if (scoreHistory.length < 2) {
        return state;
    }

    // Check stagnation: N consecutive improvements below threshold
    const recentScores = scoreHistory.slice(-criteria.stagnationWindow - 1);
    if (recentScores.length >= criteria.stagnationWindow + 1) {
        const deltas: number[] = [];
        for (let i = 1; i < recentScores.length; i++) {
            deltas.push(recentScores[i] - recentScores[i - 1]);
        }
        const allBelowThreshold = deltas.every((d) => Math.abs(d) < criteria.scoreThreshold);
        if (allBelowThreshold) {
            return {
                ...state,
                converged: true,
                convergenceReason: `Score stagnation: last ${criteria.stagnationWindow} improvements all < ${criteria.scoreThreshold} points`,
            };
        }
    }

    // Check regression: score dropped significantly
    const latest = scoreHistory[scoreHistory.length - 1];
    const previous = scoreHistory[scoreHistory.length - 2];
    if (latest < previous - 10) {
        return {
            ...state,
            converged: true,
            convergenceReason: `Score regression detected: ${Math.round(previous)} → ${Math.round(latest)} (dropped ${Math.round(previous - latest)} points). Manual review recommended.`,
        };
    }

    return state;
}

/**
 * Validate that a mirror cycle can proceed based on safety constraints.
 * Returns null if safe, or an error message string if blocked.
 */
export function validateMirrorCycleSafety(
    data: MirrorObservationData,
    safety: MirrorSafetyConfig,
): string | null {
    if (data.evaluationCount < safety.minEvaluations) {
        return `Insufficient evaluations: ${data.evaluationCount} < minimum ${safety.minEvaluations}. ` +
            `Run more score_agent + update_genome_feedback cycles first.`;
    }

    if (data.avgScore < safety.minPromoteScore) {
        return `Score too low for evolution: avgScore=${Math.round(data.avgScore)} < minPromoteScore=${safety.minPromoteScore}. ` +
            `The genome needs to accumulate a minimum average score before evolution is allowed.`;
    }

    if (data.latestAction === 'discard') {
        return `Latest feedback action is "discard" — this genome should be replaced, not evolved. ` +
            `Consider creating a new genome instead of evolving this one.`;
    }

    return null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Deduplicate proposed learnings against existing ones.
 * Uses case-insensitive prefix matching to detect near-duplicates.
 */
function deduplicateLearnings(proposed: string[], existing: string[]): string[] {
    const existingLower = existing.map((l) => l.toLowerCase());
    const seen = new Set<string>();

    return proposed.filter((learning) => {
        const lower = learning.toLowerCase();
        // Skip if exact or near-duplicate of existing
        if (existingLower.some((e) => e.includes(lower.slice(0, 40)) || lower.includes(e.slice(0, 40)))) {
            return false;
        }
        // Skip if duplicate within proposed
        if (seen.has(lower.slice(0, 40))) {
            return false;
        }
        seen.add(lower.slice(0, 40));
        return true;
    });
}

/**
 * Format a mirror cycle result as a human-readable report.
 */
export function formatMirrorReport(
    analysis: MirrorAnalysis,
    convergence: ConvergenceState,
    dryRun: boolean,
): string {
    const lines: string[] = [
        `═══ MIRROR CYCLE REPORT ═══`,
        ``,
        `[Analysis]`,
        analysis.summary,
        ``,
        `[Observations]`,
    ];

    for (const obs of analysis.observations) {
        const icon = obs.type === 'violation' ? '❌' : obs.type === 'missing' ? '⚠️' : obs.type === 'good' ? '✅' : '📌';
        lines.push(`  ${icon} [${obs.severity}] ${obs.target}: ${obs.evidence}`);
    }

    lines.push(``, `[Proposed Learnings] (${analysis.proposedLearnings.length})`);
    for (const learning of analysis.proposedLearnings) {
        lines.push(`  • ${learning}`);
    }

    lines.push(``, `[Convergence]`);
    lines.push(`  Depth: ${convergence.depth}/${convergence.maxDepth}`);
    lines.push(`  Score history: ${convergence.scoreHistory.map((s) => Math.round(s)).join(' → ')}`);
    lines.push(`  Converged: ${convergence.converged ? `YES — ${convergence.convergenceReason}` : 'NO'}`);

    if (dryRun) {
        lines.push(``, `[Mode] DRY RUN — no evolution applied`);
    }

    return lines.join('\n');
}
