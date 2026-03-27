/**
 * @module reflexivityTools
 * @description MCP tools that expose the reflexivity self-awareness testing framework.
 *
 * Previously CLI-only (`aha reflexivity cases|fixture-example|score`),
 * these tools let any agent self-assess against the 8 reflexivity dimensions
 * (identity, environment, tools, boundaries, task_type, self_eval, limitation, consistency)
 * without leaving the MCP tool loop.
 *
 * ## Workflow
 * 1. `reflexivity_list_cases` — discover available test cases
 * 2. `reflexivity_build_fixture` — build a fixture from current agent state
 * 3. `reflexivity_score_case` — score a case against a fixture + response
 */

import { z } from 'zod'
import type { McpToolContext } from './mcpContext'
import { loadReflexivityCases, getReflexivityCase } from '../../reflexivity/cases'
import { buildReflexivityFixture, type BuildReflexivityFixtureInput } from '../../reflexivity/fixtures'
import { scoreReflexivityCase } from '../../reflexivity/scorer'
import { renderRunReportMarkdown } from '../../reflexivity/reporter'
import {
    promptTurnResultSchema,
    structuredTurnAnswerSchema,
    type PromptTurnResult,
} from '../../reflexivity/schema'

function buildTurnsFromPayload(payload: unknown, prompts: readonly string[]): PromptTurnResult[] {
    const items = Array.isArray(payload)
        ? payload
        : payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>).turns)
            ? (payload as Record<string, unknown[]>).turns
            : [payload]

    return items.map((item: unknown, index: number) => {
        if (item && typeof item === 'object' && 'prompt' in item && 'rawResponse' in item) {
            return promptTurnResultSchema.parse(item)
        }

        const parsed = structuredTurnAnswerSchema.parse(item)
        return promptTurnResultSchema.parse({
            prompt: prompts[index] ?? prompts[prompts.length - 1] ?? `turn-${index}`,
            augmentedPrompt: prompts[index] ?? prompts[prompts.length - 1] ?? `turn-${index}`,
            rawResponse: JSON.stringify(parsed, null, 2),
            parsed,
            parsingError: null,
            turnIndex: index,
        })
    })
}

export function registerReflexivityTools(ctx: McpToolContext): void {
    const { mcp } = ctx

    // ── reflexivity_list_cases ───────────────────────────────────────────────
    mcp.registerTool(
        'reflexivity_list_cases',
        {
            description: [
                'List all available reflexivity self-awareness test cases.',
                'Returns the 8 dimensions with case IDs, prompts, and pass thresholds.',
                'Use this to discover what self-assessment tests are available.',
            ].join(' '),
            title: 'Reflexivity List Cases',
            inputSchema: {
                dimension: z.string().optional().describe('Filter by dimension (identity, environment, tools, boundaries, task_type, self_eval, limitation, consistency)'),
            },
        },
        async (args) => {
            try {
                const allCases = loadReflexivityCases()
                const filtered = args.dimension
                    ? allCases.filter((c) => c.dimension === args.dimension)
                    : allCases

                const cases = filtered.map((c) => ({
                    caseId: c.caseId,
                    title: c.title,
                    dimension: c.dimension,
                    interactionMode: c.interactionMode,
                    promptCount: c.prompts.length,
                    passThreshold: c.scoring.passThreshold,
                    prompts: c.prompts,
                    expectedClaimCount: c.expectedClaims.length,
                }))

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            totalCases: cases.length,
                            cases,
                        }, null, 2),
                    }],
                }
            } catch (error) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Error listing reflexivity cases: ${String(error)}`,
                    }],
                    isError: true,
                }
            }
        },
    )

    // ── reflexivity_build_fixture ────────────────────────────────────────────
    mcp.registerTool(
        'reflexivity_build_fixture',
        {
            description: [
                'Build a reflexivity fixture from current agent state.',
                'A fixture captures identity, task, environment, tool, boundary, and limitation snapshots.',
                'Pass raw text from get_self_view, get_team_info, and spawn boundary context.',
                'The fixture is then used with reflexivity_score_case to evaluate self-awareness.',
            ].join(' '),
            title: 'Reflexivity Build Fixture',
            inputSchema: {
                selfViewText: z.string().optional().describe('Raw output from get_self_view() MCP tool'),
                teamInfoText: z.string().optional().describe('Raw output from get_team_info() MCP tool'),
                spawnBoundaryContextText: z.string().optional().describe('Raw spawn boundary context from agent startup'),
                sessionId: z.string().optional().describe('Current session ID'),
                teamId: z.string().optional().describe('Current team ID'),
                runtimeType: z.string().optional().describe('Runtime type (claude or codex)'),
            },
        },
        async (args) => {
            try {
                const input: BuildReflexivityFixtureInput = {
                    collectedAt: Date.now(),
                    context: {
                        sessionId: args.sessionId ?? null,
                        teamId: args.teamId ?? null,
                        runtimeType: args.runtimeType ?? null,
                    },
                    raw: {
                        selfViewText: args.selfViewText ?? null,
                        teamInfoText: args.teamInfoText ?? null,
                        spawnBoundaryContextText: args.spawnBoundaryContextText ?? null,
                    },
                }

                const fixture = buildReflexivityFixture(input)

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify(fixture, null, 2),
                    }],
                }
            } catch (error) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Error building fixture: ${String(error)}`,
                    }],
                    isError: true,
                }
            }
        },
    )

    // ── reflexivity_score_case ───────────────────────────────────────────────
    mcp.registerTool(
        'reflexivity_score_case',
        {
            description: [
                'Score a reflexivity self-awareness case.',
                'Provide a caseId, a fixture (from reflexivity_build_fixture), and your response turns.',
                'Each turn should have: { answer, claims: [...], unknowns: [...], limitations: [...], corrections: [...], confidence }.',
                'Returns accuracy, completeness, honesty, and consistency scores.',
            ].join(' '),
            title: 'Reflexivity Score Case',
            inputSchema: {
                caseId: z.string().describe('Reflexivity case ID (e.g. RFX-SELF-001)'),
                fixture: z.record(z.unknown()).describe('Fixture JSON from reflexivity_build_fixture'),
                responses: z.array(z.record(z.unknown())).describe('Array of structured turn answers, one per prompt in the case'),
            },
        },
        async (args) => {
            try {
                const reflexivityCase = getReflexivityCase(args.caseId)

                const { reflexivityFixtureSchema } = await import('../../reflexivity/schema')
                const fixture = reflexivityFixtureSchema.parse(args.fixture)

                const turns = buildTurnsFromPayload(args.responses, reflexivityCase.prompts)

                const result = scoreReflexivityCase({
                    reflexivityCase,
                    fixture,
                    turns,
                })

                const report = renderRunReportMarkdown({
                    generatedAt: Date.now(),
                    caseResults: [result],
                    summary: {
                        totalCases: 1,
                        passedCases: result.score.passed ? 1 : 0,
                        failedCases: result.score.passed ? 0 : 1,
                        averageScore: result.score.totalScore,
                    },
                })

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            caseId: args.caseId,
                            passed: result.score.passed,
                            score: result.score,
                            markdown: report,
                        }, null, 2),
                    }],
                }
            } catch (error) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `Error scoring case: ${String(error)}`,
                    }],
                    isError: true,
                }
            }
        },
    )
}
