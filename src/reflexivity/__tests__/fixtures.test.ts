import { describe, expect, it } from 'vitest'
import { buildReflexivityFixture, buildToolState, parseSelfView, parseSpawnBoundaryContext, parseTeamInfo } from '../fixtures'

describe('reflexivity fixtures', () => {
    it('parses self view text', () => {
        const parsed = parseSelfView(`═══ SELF VIEW ═══\n\n[Identity]\n  Role: builder\n  Genome: builder\n  Description: No genome loaded\n  Responsibilities: ship, verify\n  Session: sess-1\n\n[Team: team-1]\n  2 alive\n  🟢 builder (YOU): alive (3s ago) [codex]`)

        expect(parsed).toEqual({
            sessionId: 'sess-1',
            role: 'builder',
            genomeName: 'builder',
            genomeDescription: 'No genome loaded',
            responsibilities: ['ship', 'verify'],
            teamId: 'team-1',
            runtimeType: 'codex',
        })
    })

    it('parses team info text', () => {
        const parsed = parseTeamInfo(`# Team Context Information\n\n## Your Identity\n- **Session ID**: sess-1\n- **Role**: builder\n\n## Your Responsibilities\n- Build\n- Test\n\n## Your Boundaries\n- Stay in scope\n\n---\n**Team ID**: team-1`)

        expect(parsed).toEqual({
            sessionId: 'sess-1',
            role: 'builder',
            responsibilities: ['Build', 'Test'],
            boundaries: ['Stay in scope'],
            teamId: 'team-1',
        })
    })

    it('parses spawn-time boundary context', () => {
        const parsed = parseSpawnBoundaryContext(`foo\n## Spawn-Time Boundary Context\n- Read first: /repo/SYSTEM.md ; /repo/AGENTS.md\n- Primary write scope: /repo/**\n- Avoid sibling project trees unless explicitly assigned: aha-cli/**, benchmark/**\n- Guidance docs are read-only context unless explicitly assigned: SYSTEM.md, AGENTS.md\n- Help lane: if blocked, call request_help or mention @help in team chat\n- Context mirror: call get_context_status`)

        expect(parsed.readFirst).toEqual(['/repo/SYSTEM.md', '/repo/AGENTS.md'])
        expect(parsed.primaryWriteScope).toBe('/repo/**')
        expect(parsed.avoidScopes).toEqual(['aha-cli/**', 'benchmark/**'])
        expect(parsed.readOnlyDocs).toEqual(['SYSTEM.md', 'AGENTS.md'])
        expect(parsed.helpLane).toEqual(['request_help', '@help', 'send_team_message'])
        expect(parsed.contextMirrorRule).toContain('get_context_status')
    })

    it('classifies tool states consistently', () => {
        expect(buildToolState('get_team_config', { value: { ok: true } }).status).toBe('ok')
        expect(buildToolState('get_genome_spec', { accessMode: 'precondition_required', error: 'specId missing' }).status).toBe('unavailable')
        expect(buildToolState('get_effective_permissions', { accessMode: 'allowed', error: 'ROLE_DEFINITIONS missing' }).status).toBe('failed')
        expect(buildToolState('get_genome_spec', { accessMode: 'permission_denied' }).status).toBe('permission_denied')
    })

    it('builds a normalized fixture and records failed probes', () => {
        const fixture = buildReflexivityFixture({
            context: { runtimeType: 'codex' },
            raw: {
                selfViewText: `═══ SELF VIEW ═══\n\n[Identity]\n  Role: builder\n  Genome: builder\n  Description: No genome loaded\n  Session: sess-1\n\n[Team: team-1]\n  2 alive\n  🟢 builder (YOU): alive (3s ago) [codex]`,
                teamInfoText: `# Team Context Information\n\n## Your Identity\n- **Session ID**: sess-1\n- **Role**: builder\n\n## Your Responsibilities\n- Build\n\n---\n**Team ID**: team-1`,
                teamConfigOutput: JSON.stringify({ teamId: 'team-1', name: '能力检测' }),
                spawnBoundaryContextText: `## Spawn-Time Boundary Context\n- Read first: /repo/SYSTEM.md ; /repo/AGENTS.md\n- Primary write scope: /repo/**\n- Help lane: use request_help and @help`,
                toolProbes: {
                    get_team_config: { accessMode: 'allowed', value: { teamId: 'team-1' } },
                    get_effective_permissions: { accessMode: 'allowed', error: 'ROLE_DEFINITIONS.yaml not found' },
                },
            },
        })

        expect(fixture.identitySnapshot.role).toBe('builder')
        expect(fixture.identitySnapshot.teamName).toBe('能力检测')
        expect(fixture.boundarySnapshot.primaryWriteScope).toBe('/repo/**')
        expect(fixture.toolSnapshot.tools.get_effective_permissions.status).toBe('failed')
        expect(fixture.collectionLog.some((entry) => entry.step === 'probe:get_effective_permissions')).toBe(true)
        expect(fixture.limitationsSnapshot.active.some((entry) => entry.includes('get_effective_permissions failed'))).toBe(true)
    })
})
