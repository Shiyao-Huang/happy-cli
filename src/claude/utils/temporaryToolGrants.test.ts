import { describe, expect, it } from 'vitest';
import {
    computeEffectiveAllowedToolsFromMetadata,
    hasDynamicGrantOptIn,
    isHardDeniedDynamicGrantTool,
    listActiveTemporaryGrantToolsFromMetadata,
    normalizeGrantedToolName,
} from './temporaryToolGrants';

describe('temporaryToolGrants', () => {
    it('normalizes MCP-prefixed tool names', () => {
        expect(normalizeGrantedToolName('mcp__aha__get_genome_spec')).toBe('get_genome_spec');
        expect(normalizeGrantedToolName('get_genome_spec')).toBe('get_genome_spec');
    });

    it('recognizes opt-in token across lightweight genome string arrays', () => {
        expect(hasDynamicGrantOptIn({
            tags: ['safe', '@granted'],
        } as any)).toBe(true);
        expect(hasDynamicGrantOptIn({
            capabilities: ['review'],
        } as any)).toBe(false);
    });

    it('filters expired, revoked, and hard-denied grants from metadata', () => {
        const grants = listActiveTemporaryGrantToolsFromMetadata({
            temporaryToolGrants: [
                {
                    id: 'g1',
                    tool: 'get_genome_spec',
                    grantedBy: 'master',
                    reason: 'qa',
                    expiresAt: '2026-04-05T06:00:00.000Z',
                },
                {
                    id: 'g2',
                    tool: 'delete_file',
                    grantedBy: 'master',
                    reason: 'bad',
                    expiresAt: '2026-04-05T06:00:00.000Z',
                },
                {
                    id: 'g3',
                    tool: 'get_self_view',
                    grantedBy: 'master',
                    reason: 'expired',
                    expiresAt: '2026-04-05T04:00:00.000Z',
                },
                {
                    id: 'g4',
                    tool: 'list_tasks',
                    grantedBy: 'master',
                    reason: 'revoked',
                    expiresAt: '2026-04-05T06:00:00.000Z',
                    revokedAt: '2026-04-05T05:00:00.000Z',
                },
            ],
        } as any, Date.parse('2026-04-05T05:30:00.000Z'));

        expect(grants.map((grant) => grant.id)).toEqual(['g1']);
    });

    it('merges active grants into a static allowlist while keeping disallowed precedence', () => {
        const effective = computeEffectiveAllowedToolsFromMetadata({
            baseAllowedTools: ['get_self_view', 'list_tasks'],
            baseDisallowedTools: ['kill_agent', 'get_genome_spec'],
            dynamicGrantOptIn: true,
            metadata: {
                temporaryToolGrants: [
                    {
                        id: 'g1',
                        tool: 'mcp__aha__get_genome_spec',
                        grantedBy: 'master',
                        reason: 'qa',
                        expiresAt: '2026-04-05T06:00:00.000Z',
                    },
                    {
                        id: 'g2',
                        tool: 'get_task',
                        grantedBy: 'master',
                        reason: 'qa',
                        expiresAt: '2026-04-05T06:00:00.000Z',
                    },
                ],
            } as any,
            nowMs: Date.parse('2026-04-05T05:30:00.000Z'),
        });

        expect(effective.activeGrantTools).toEqual(['get_task']);
        expect(effective.allowedTools).toEqual(['get_self_view', 'list_tasks', 'get_task']);
        expect(effective.disallowedTools).toEqual(['kill_agent', 'get_genome_spec']);
    });

    it('never allows hard-denied destructive tools through dynamic grants', () => {
        expect(isHardDeniedDynamicGrantTool('delete_file')).toBe(true);
        expect(isHardDeniedDynamicGrantTool('Edit')).toBe(true);
        expect(isHardDeniedDynamicGrantTool('get_genome_spec')).toBe(false);
    });
});
