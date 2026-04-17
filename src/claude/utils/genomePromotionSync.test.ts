import { describe, expect, it } from 'vitest'

import { promoteGenomeViaMarketplace, submitPackageDiffViaMarketplace } from './genomePromotionSync'

const TEST_HUB_URL = 'https://aha-agi.com/genome'
const TEST_SERVER_URL = 'https://aha-agi.com/api'

function response(status: number, body: string) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async text() {
            return body
        },
    }
}

describe('promoteGenomeViaMarketplace', () => {
    it('promotes directly when genome-hub accepts the request', async () => {
        const calls: Array<{ input: string; method?: string }> = []
        const fetchImpl = async (input: string, init?: RequestInit) => {
            calls.push({ input, method: init?.method })
            return response(201, '{"genome":{"id":"g-1","version":2}}')
        }

        const result = await promoteGenomeViaMarketplace({
            target: { namespace: '@official', name: 'supervisor' },
            payload: {
                spec: '{"displayName":"Supervisor"}',
                isPublic: true,
                minAvgScore: 60,
            },
            hubUrl: TEST_HUB_URL,
            fetchImpl: fetchImpl as any,
        })

        expect(result).toMatchObject({
            ok: true,
            status: 201,
            transport: 'direct-hub',
        })
        expect(calls).toEqual([
            {
                input: `${TEST_HUB_URL}/genomes/%40official/supervisor/promote`,
                method: 'POST',
            },
        ])
    })

    it('falls back to happy-server proxy when direct genome-hub promote returns 401', async () => {
        const calls: Array<{ input: string; method?: string; auth?: string | null }> = []
        const fetchImpl = async (input: string, init?: RequestInit) => {
            calls.push({
                input,
                method: init?.method,
                auth: init?.headers && typeof init.headers === 'object' && 'Authorization' in init.headers
                    ? (init.headers as Record<string, string>).Authorization
                    : null,
            })

            if (input.startsWith(`${TEST_HUB_URL}/`)) {
                return response(401, '{"error":"Unauthorized"}')
            }

            return response(201, '{"genome":{"id":"g-2","version":3}}')
        }

        const result = await promoteGenomeViaMarketplace({
            target: { namespace: '@official', name: 'supervisor' },
            payload: {
                spec: '{"displayName":"Supervisor"}',
                isPublic: true,
                minAvgScore: 60,
            },
            hubUrl: TEST_HUB_URL,
            fetchImpl: fetchImpl as any,
            authToken: 'user-token',
            serverUrl: TEST_SERVER_URL,
        })

        expect(result).toMatchObject({
            ok: true,
            status: 201,
            transport: 'server-proxy',
        })
        expect(calls).toEqual([
            {
                input: `${TEST_HUB_URL}/genomes/%40official/supervisor/promote`,
                method: 'POST',
                auth: null,
            },
            {
                input: 'https://aha-agi.com/v1/genomes/%40official/supervisor/promote',
                method: 'POST',
                auth: 'Bearer user-token',
            },
        ])
    })
})

describe('submitPackageDiffViaMarketplace', () => {
    it('submits package diffs directly when genome-hub accepts the request', async () => {
        const calls: Array<{ input: string; method?: string }> = []
        const fetchImpl = async (input: string, init?: RequestInit) => {
            calls.push({ input, method: init?.method })
            return response(201, '{"entity":{"id":"e-1","version":2},"diff":{"id":"d-1"}}')
        }

        const result = await submitPackageDiffViaMarketplace({
            entityId: 'entity-1',
            payload: {
                description: 'Mutate package manifest',
                baseVersion: 1,
                ops: [
                    { type: 'manifest_set', path: 'behavior.onIdle', value: 'self-assign' },
                ],
            },
            hubUrl: TEST_HUB_URL,
            fetchImpl: fetchImpl as any,
        })

        expect(result).toMatchObject({
            ok: true,
            status: 201,
            transport: 'direct-hub',
        })
        expect(calls).toEqual([
            {
                input: `${TEST_HUB_URL}/entities/id/entity-1/package-diffs`,
                method: 'POST',
            },
        ])
    })

    it('falls back to server proxy when direct hub returns 403 and authToken is provided', async () => {
        const calls: Array<{ input: string; method?: string; auth?: string | null }> = []
        const fetchImpl = async (input: string, init?: RequestInit) => {
            calls.push({
                input,
                method: init?.method,
                auth: init?.headers && typeof init.headers === 'object' && 'Authorization' in init.headers
                    ? (init.headers as Record<string, string>).Authorization
                    : null,
            })

            if (input.includes('aha-agi.com')) {
                return response(403, '{"error":"Forbidden"}')
            }
            return response(201, '{"entity":{"id":"e-1","version":2},"diff":{"id":"d-1"}}')
        }

        const result = await submitPackageDiffViaMarketplace({
            entityId: 'entity-1',
            payload: {
                description: 'Mutate package manifest',
                baseVersion: 1,
                ops: [
                    { type: 'manifest_set', path: 'behavior.onIdle', value: 'self-assign' },
                ],
            },
            hubUrl: TEST_HUB_URL,
            authToken: 'test-token',
            serverUrl: 'https://api.test.com',
            fetchImpl: fetchImpl as any,
        })

        expect(result).toMatchObject({
            ok: true,
            status: 201,
            transport: 'server-proxy',
        })
        expect(calls).toHaveLength(2)
        expect(calls[0].input).toContain('aha-agi.com')
        expect(calls[1].input).toContain('api.test.com')
        expect(calls[1].auth).toBe('Bearer test-token')
    })

    it('does not fall back when no authToken is provided', async () => {
        const calls: Array<{ input: string; method?: string }> = []
        const fetchImpl = async (input: string, init?: RequestInit) => {
            calls.push({ input, method: init?.method })
            return response(403, '{"error":"Forbidden"}')
        }

        const result = await submitPackageDiffViaMarketplace({
            entityId: 'entity-1',
            payload: {
                description: 'Mutate package manifest',
                baseVersion: 1,
                ops: [
                    { type: 'manifest_set', path: 'behavior.onIdle', value: 'self-assign' },
                ],
            },
            hubUrl: TEST_HUB_URL,
            fetchImpl: fetchImpl as any,
        })

        expect(result).toMatchObject({
            ok: false,
            status: 403,
            transport: 'direct-hub',
        })
        expect(calls).toHaveLength(1)
    })
})
