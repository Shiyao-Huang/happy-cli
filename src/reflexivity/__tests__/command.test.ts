import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildReflexivityFixture } from '../fixtures'
import { buildTurnsFromResponsePayload, fixtureExampleCommand, scoreCaseCommand } from '../command'

describe('reflexivity command helpers', () => {
    it('builds prompt turns from structured response payload', () => {
        const turns = buildTurnsFromResponsePayload([
            {
                answer: '我是 builder',
                claims: [{ claimType: 'role', subject: 'self', value: 'builder', status: 'known' }],
                unknowns: [],
                limitations: [],
                corrections: [],
            },
        ], ['你是谁？'])

        expect(turns).toHaveLength(1)
        expect(turns[0].prompt).toBe('你是谁？')
        expect(turns[0].parsed?.claims[0].claimType).toBe('role')
    })

    it('scores a case from fixture/response files', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reflexivity-cli-'))
        const fixturePath = path.join(tmp, 'fixture.json')
        const responsePath = path.join(tmp, 'response.json')
        const outputDir = path.join(tmp, 'out')

        const fixture = buildReflexivityFixture({
            fixtureId: 'fx-cli',
            snapshots: {
                identitySnapshot: { role: 'builder' },
            },
        })
        fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2), 'utf-8')
        fs.writeFileSync(responsePath, JSON.stringify({
            answer: '我是 builder',
            claims: [{ claimType: 'role', subject: 'self', value: 'builder', status: 'known', source: 'self_view' }],
            unknowns: [],
            limitations: [],
            corrections: [],
        }, null, 2), 'utf-8')

        const result = await scoreCaseCommand({
            flags: {
                json: false,
                verbose: false,
                quiet: false,
                yes: false,
                help: false,
                positional: [],
                options: new Map([
                    ['case', 'RFX-SELF-001'],
                    ['fixture', fixturePath],
                    ['response', responsePath],
                    ['out', outputDir],
                ]),
                flags: new Set(),
            },
            args: [],
            api: async () => {
                throw new Error('not used')
            },
        })

        expect(result.ok).toBe(true)
        expect((result.data as any).score.totalScore).toBeGreaterThan(0)
        expect(fs.existsSync(path.join(outputDir, 'rfx-self-001.json'))).toBe(true)
        expect(fs.existsSync(path.join(outputDir, 'rfx-self-001.md'))).toBe(true)
    })

    it('fixture example command returns a valid fixture', async () => {
        const result = await fixtureExampleCommand({
            flags: {
                json: false,
                verbose: false,
                quiet: false,
                yes: false,
                help: false,
                positional: [],
                options: new Map(),
                flags: new Set(),
            },
            args: [],
            api: async () => {
                throw new Error('not used')
            },
        })

        expect(result.ok).toBe(true)
        expect((result.data as any).schemaVersion).toBe('reflexivity-fixture-v1')
    })
})
