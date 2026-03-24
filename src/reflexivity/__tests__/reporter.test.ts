import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildReflexivityFixture } from '../fixtures'
import { renderRunReportMarkdown, serializeRunReportJson, writeRunReportFiles } from '../reporter'
import { scoreReflexivityCase } from '../scorer'
import type { ReflexivityCase } from '../schema'

describe('reflexivity reporter', () => {
    it('renders markdown and writes report files', () => {
        const fixture = buildReflexivityFixture({
            snapshots: {
                identitySnapshot: { role: 'builder' },
            },
        })
        const reflexivityCase: ReflexivityCase = {
            schemaVersion: 'reflexivity-case-v1',
            caseId: 'CASE-REPORT',
            title: 'report',
            dimension: 'identity',
            interactionMode: 'single_turn',
            prompts: ['who'],
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
                criticalClaims: [],
                passThreshold: 60,
            },
            notes: '',
        }

        const caseResult = scoreReflexivityCase({
            reflexivityCase,
            fixture,
            turns: [{
                prompt: 'who',
                augmentedPrompt: 'augmented',
                rawResponse: '{}',
                parsed: { answer: '我是 builder', claims: [{ claimType: 'role', subject: 'self', value: 'builder', status: 'known', source: 'self_view' }], unknowns: [], limitations: [], corrections: [], confidence: 'high' },
                parsingError: null,
                turnIndex: 0,
            }],
        })

        const report = {
            generatedAt: Date.now(),
            caseResults: [caseResult],
            summary: {
                totalCases: 1,
                passedCases: 1,
                failedCases: 0,
                averageScore: caseResult.score.totalScore,
            },
        }

        const markdown = renderRunReportMarkdown(report)
        const json = serializeRunReportJson(report)
        expect(markdown).toContain('# Reflexivity Run Report')
        expect(markdown).toContain('CASE-REPORT')
        expect(JSON.parse(json).summary.totalCases).toBe(1)

        const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflexivity-report-'))
        const written = writeRunReportFiles({ report, outputDir })
        expect(fs.existsSync(written.jsonPath)).toBe(true)
        expect(fs.existsSync(written.markdownPath)).toBe(true)
    })
})
