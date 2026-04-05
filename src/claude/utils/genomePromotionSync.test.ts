import { describe, expect, it } from 'vitest'

import { createGenomeViaMarketplace, promoteGenomeViaMarketplace, submitDiffViaMarketplace, submitPackageDiffViaMarketplace } from './genomePromotionSync'

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
            fetchImpl: fetchImpl as any,
        })

        expect(result).toMatchObject({
            ok: true,
            status: 201,
            transport: 'direct-hub',
        })
        expect(calls).toEqual([
            {
                input: 'https://aha-agi.com/genome/genomes/%40official/supervisor/promote',
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

            if (input.startsWith('https://aha-agi.com/genome/')) {
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
            fetchImpl: fetchImpl as any,
            authToken: 'user-token',
            serverUrl: 'https://aha-agi.com/api',
        })

        expect(result).toMatchObject({
            ok: true,
            status: 201,
            transport: 'server-proxy',
        })
        expect(calls).toEqual([
            {
                input: 'https://aha-agi.com/genome/genomes/%40official/supervisor/promote',
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
            fetchImpl: fetchImpl as any,
        })

        expect(result).toMatchObject({
            ok: true,
            status: 201,
            transport: 'direct-hub',
        })
        expect(calls).toEqual([
            {
                input: 'https://aha-agi.com/genome/entities/id/entity-1/package-diffs',
                method: 'POST',
            },
        ])
    })

    it('does not fall back to happy-server proxy when direct package diff submit is rejected', async () => {
        const calls: Array<{ input: string; method?: string; auth?: string | null }> = []
        const fetchImpl = async (input: string, init?: RequestInit) => {
            calls.push({
                input,
                method: init?.method,
                auth: init?.headers && typeof init.headers === 'object' && 'Authorization' in init.headers
                    ? (init.headers as Record<string, string>).Authorization
                    : null,
            })

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
            fetchImpl: fetchImpl as any,
        })

        expect(result).toMatchObject({
            ok: false,
            status: 403,
            transport: 'direct-hub',
        })
        expect(calls).toEqual([
            {
                input: 'https://aha-agi.com/genome/entities/id/entity-1/package-diffs',
                method: 'POST',
                auth: null,
            },
        ])
    })
})
