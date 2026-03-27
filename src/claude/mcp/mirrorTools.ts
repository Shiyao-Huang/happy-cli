/**
 * @module mirrorTools
 * @description MCP tools that expose the Mirror feedback loop analysis functions.
 *
 * The Mirror system enables agents to observe their own behavior,
 * analyze gaps between genome spec and actual performance, and determine
 * whether evolution is warranted — all without committing to changes.
 *
 * ## Workflow
 * 1. `mirror_analyze` — observe + analyze gaps between spec and actual behavior
 * 2. `mirror_check_convergence` — check if repeated evolution has converged
 * 3. `mirror_format_report` — render analysis + convergence as readable report
 */

import { z } from 'zod'
import type { McpToolContext } from './mcpContext'
import {
    analyzeObservations,
    checkConvergence,
    validateMirrorCycleSafety,
    formatMirrorReport,
} from './mirrorAnalysis'
import {
    DEFAULT_MIRROR_SAFETY,
    type MirrorObservationData,
    type MirrorObservation,
} from './mirrorTypes'

export function registerMirrorTools(ctx: McpToolContext): void {
    const { mcp } = ctx

    // ── mirror_analyze ──────────────────────────────────────────────────────
    mcp.registerTool(
        'mirror_analyze',
        {
            description: [
                'Analyze agent behavior against its genome spec.',
                'Takes observation data (scores, dimensions, feedback) and identifies gaps,',
                'proposes learnings, and decides whether genome evolution is warranted.',
                'This is a read-only analysis — no changes are made to the genome.',
                'Use this before evolve_genome to preview what would change.',
            ].join(' '),
            title: 'Mirror Analyze',
            inputSchema: {
                sessionId: z.string().describe('Session being analyzed'),
                genomeNamespace: z.string().describe('Genome namespace (e.g. "@official")'),
                genomeName: z.string().describe('Genome name'),
                genomeVersion: z.number().describe('Current genome version number'),
                avgScore: z.number().describe('Current average score from feedback'),
                dimensions: z.object({
                    delivery: z.number().describe('Delivery score'),
                    integrity: z.number().describe('Integrity score'),
                    efficiency: z.number().describe('Efficiency score'),
                    collaboration: z.number().describe('Collaboration score'),
                    reliability: z.number().describe('Reliability score'),
                }).describe('Score breakdown: { delivery, integrity, efficiency, collaboration, reliability }'),
                latestAction: z.enum(['keep', 'keep_with_guardrails', 'mutate', 'discard']).describe('Latest feedback action'),
                suggestions: z.array(z.string()).optional().describe('Suggestions from supervisor evaluations'),
                evaluationCount: z.number().describe('Number of evaluations aggregated'),
                existingLearnings: z.array(z.string()).optional().describe('Existing learnings already in genome memory'),
            },
        },
        async (args) => {
            try {
                const data: MirrorObservationData = {
                    sessionId: args.sessionId,
                    genomeNamespace: args.genomeNamespace,
                    genomeName: args.genomeName,
                    genomeVersion: args.genomeVersion,
                    avgScore: args.avgScore,
                    dimensions: args.dimensions,
                    latestAction: args.latestAction,
                    suggestions: args.suggestions ?? [],
                    evaluationCount: args.evaluationCount,
                    existingLearnings: args.existingLearnings ?? [],
                }

                const safetyCheck = validateMirrorCycleSafety(data, DEFAULT_MIRROR_SAFETY)
                const analysis = analyzeObservations(data)

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            analysis: {
                                observations: analysis.observations,
                                proposedLearnings: analysis.proposedLearnings,
                                shouldEvolve: analysis.shouldEvolve,
                                skipReason: analysis.skipReason,
                                summary: analysis.summary,
                            },
                            safetyCheck: safetyCheck
                                ? { blocked: true, reason: safetyCheck }
                                : { blocked: false },
                        }, null, 2),
                    }],
                }
            } catch (error) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Error analyzing observations: ${String(error)}`,
                    }],
                    isError: true,
                }
            }
        },
    )

    // ── mirror_check_convergence ─────────────────────────────────────────────
    mcp.registerTool(
        'mirror_check_convergence',
        {
            description: [
                'Check if the mirror evolution loop has converged.',
                'Examines score history for stagnation, regression, or max depth.',
                'Use this to decide whether to continue iterating on genome evolution.',
            ].join(' '),
            title: 'Mirror Check Convergence',
            inputSchema: {
                scoreHistory: z.array(z.number()).describe('Array of scores from consecutive evolution iterations'),
                currentDepth: z.number().optional().describe('Current iteration depth (0-indexed). Default: 0'),
                maxDepth: z.number().optional().describe('Maximum allowed depth. Default: 3'),
                scoreThreshold: z.number().optional().describe('Minimum score improvement to avoid stagnation. Default: 2.0'),
                stagnationWindow: z.number().optional().describe('Consecutive low-improvement iterations before convergence. Default: 2'),
            },
        },
        async (args) => {
            try {
                const criteria = {
                    scoreThreshold: args.scoreThreshold ?? DEFAULT_MIRROR_SAFETY.convergence.scoreThreshold,
                    minDimensionScore: DEFAULT_MIRROR_SAFETY.convergence.minDimensionScore,
                    stagnationWindow: args.stagnationWindow ?? DEFAULT_MIRROR_SAFETY.convergence.stagnationWindow,
                }

                const convergence = checkConvergence(
                    args.scoreHistory,
                    criteria,
                    args.currentDepth ?? 0,
                    args.maxDepth ?? DEFAULT_MIRROR_SAFETY.maxDepth,
                )

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            converged: convergence.converged,
                            reason: convergence.convergenceReason ?? null,
                            depth: convergence.depth,
                            maxDepth: convergence.maxDepth,
                            scoreHistory: convergence.scoreHistory,
                        }, null, 2),
                    }],
                }
            } catch (error) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Error checking convergence: ${String(error)}`,
                    }],
                    isError: true,
                }
            }
        },
    )

    // ── mirror_format_report ────────────────────────────────────────────────
    mcp.registerTool(
        'mirror_format_report',
        {
            description: [
                'Generate a human-readable mirror cycle report.',
                'Combines analysis results and convergence state into a formatted summary.',
                'Pass the output of mirror_analyze and mirror_check_convergence.',
            ].join(' '),
            title: 'Mirror Format Report',
            inputSchema: {
                analysis: z.object({
                    observations: z.array(z.object({
                        type: z.enum(['violation', 'missing', 'exceeded', 'good']).describe('Observation type'),
                        target: z.string().describe('Which genome spec field is involved'),
                        evidence: z.string().describe('Evidence for this observation'),
                        severity: z.enum(['low', 'medium', 'high']).describe('How impactful this gap is'),
                    })).describe('Structured observations from analysis'),
                    proposedLearnings: z.array(z.string()).describe('Proposed learnings to merge into genome'),
                    summary: z.string().describe('Summary of the analysis'),
                    shouldEvolve: z.boolean().describe('Whether evolution is warranted'),
                    skipReason: z.string().optional().describe('Reason if evolution is not warranted'),
                }).describe('Analysis result from mirror_analyze'),
                convergence: z.object({
                    depth: z.number().describe('Current iteration depth'),
                    maxDepth: z.number().describe('Maximum allowed depth'),
                    scoreHistory: z.array(z.number()).describe('Score history across iterations'),
                    converged: z.boolean().describe('Whether convergence has been reached'),
                    convergenceReason: z.string().optional().describe('Reason convergence was declared'),
                }).describe('Convergence state from mirror_check_convergence'),
                dryRun: z.boolean().optional().describe('Whether this is a dry run (no actual evolution). Default: true'),
            },
        },
        async (args) => {
            try {
                const analysisInput = {
                    observations: args.analysis.observations as MirrorObservation[],
                    proposedLearnings: args.analysis.proposedLearnings,
                    summary: args.analysis.summary,
                    shouldEvolve: args.analysis.shouldEvolve,
                    skipReason: args.analysis.skipReason,
                }

                const convergenceInput = {
                    depth: args.convergence.depth,
                    maxDepth: args.convergence.maxDepth,
                    scoreHistory: args.convergence.scoreHistory,
                    converged: args.convergence.converged,
                    convergenceReason: args.convergence.convergenceReason,
                }

                const report = formatMirrorReport(analysisInput, convergenceInput, args.dryRun ?? true)

                return {
                    content: [{
                        type: 'text' as const,
                        text: report,
                    }],
                }
            } catch (error) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Error formatting report: ${String(error)}`,
                    }],
                    isError: true,
                }
            }
        },
    )
}
