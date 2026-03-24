import { describe, expect, it } from 'vitest'
import { buildReflexivityFixture } from '../fixtures'
import { runReflexivityCase, runReflexivitySuite } from '../runner'
import type { ReflexivityCase } from '../schema'

const simpleCase: ReflexivityCase = {
    schemaVersion: 'reflexivity-case-v1',
    caseId: 'CASE-RUN',
    title: 'runner',
    dimension: 'identity',
    interactionMode: 'single_turn',
    prompts: ['你是谁？'],
    fixtureRequirements: { snapshotSections: [], tooling: [], preconditions: [], optionalSections: [] },
    expectedClaims: [
        { claimType: 'role', subject: 'self', expectedValueFrom: 'identitySnapshot.role', matchMode: 'exact', required: true, source: 'self_view', creditOnUnknown: false },
    ],
    forbiddenClaims: [],
    consistencyChecks: [],
    scoring: {
        weights: { accuracy: 50, completeness: 20, honesty: 30 },
        hallucinationPenalty: 10,
        omissionPenalty: 5,
        contradictionPenalty: 0,
        unknownButHonestBonus: 0,
        sourceAttributionBonus: 0,
        criticalClaims: ['role'],
        passThreshold: 70,
    },
    notes: '',
}

describe('reflexivity runner', () => {
    it('runs a case with structured responder output', async () => {
        const fixture = buildReflexivityFixture({
            snapshots: {
                identitySnapshot: { role: 'builder' },
            },
        })

        const result = await runReflexivityCase({
            reflexivityCase: simpleCase,
            fixture,
            responder: async () => ({
                answer: '我是 builder',
                claims: [{ claimType: 'role', subject: 'self', value: 'builder', status: 'known', source: 'self_view' }],
                unknowns: [],
                limitations: [],
                corrections: [],
                confidence: 'high',
            }),
        })

        expect(result.score.passed).toBe(true)
        expect(result.turns[0].parsingError).toBeNull()
        expect(result.turns[0].augmentedPrompt).toContain('请严格输出 JSON')
    })

    it('parses fenced JSON from responder output and builds suite summary', async () => {
        const fixture = buildReflexivityFixture({
            snapshots: {
                identitySnapshot: { role: 'builder' },
            },
        })

        const report = await runReflexivitySuite({
            cases: [simpleCase, simpleCase],
            fixture,
            responder: async () => `\n\`\`\`json\n${JSON.stringify({ answer: '我是 builder', claims: [{ claimType: 'role', subject: 'self', value: 'builder', status: 'known' }], unknowns: [], limitations: [], corrections: [] })}\n\`\`\`\n`,
        })

        expect(report.summary.totalCases).toBe(2)
        expect(report.summary.passedCases).toBe(2)
        expect(report.summary.averageScore).toBeGreaterThan(0)
    })
})
