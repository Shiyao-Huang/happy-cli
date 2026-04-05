import { describe, expect, it } from 'vitest';

import {
    GenomeLifecycleSchema,
    GenomeProvenanceOriginSchema,
    GenomeRuntimeTypeSchema,
    parseGenomeSpec,
    type Genome,
} from './genome';

describe('genome runtime metadata validation', () => {
    it('accepts only supported runtime types', () => {
        expect(GenomeRuntimeTypeSchema.safeParse('claude').success).toBe(true);
        expect(GenomeRuntimeTypeSchema.safeParse('codex').success).toBe(true);
        expect(GenomeRuntimeTypeSchema.safeParse('open-code').success).toBe(true);
        expect(GenomeRuntimeTypeSchema.safeParse('gpt').success).toBe(false);
    });

    it('accepts only supported provenance origins', () => {
        expect(GenomeProvenanceOriginSchema.safeParse('original').success).toBe(true);
        expect(GenomeProvenanceOriginSchema.safeParse('forked').success).toBe(true);
        expect(GenomeProvenanceOriginSchema.safeParse('mutated').success).toBe(true);
        expect(GenomeProvenanceOriginSchema.safeParse('cloned').success).toBe(false);
    });

    it('accepts only supported lifecycle values', () => {
        expect(GenomeLifecycleSchema.safeParse('experimental').success).toBe(true);
        expect(GenomeLifecycleSchema.safeParse('active').success).toBe(true);
        expect(GenomeLifecycleSchema.safeParse('deprecated').success).toBe(true);
        expect(GenomeLifecycleSchema.safeParse('archived').success).toBe(false);
    });

    it('preserves new market-facing fields when parsing genome spec', () => {
        const genome: Genome = {
            id: 'genome-1',
            accountId: 'account-1',
            name: 'market-agent',
            parentSessionId: 'session-1',
            spec: JSON.stringify({
                runtimeType: 'claude',
                lifecycle: 'active',
                trigger: {
                    mode: 'event',
                    conditions: ['PR opened'],
                },
                behavior: {
                    onRetire: 'write-handoff',
                },
                provenance: {
                    origin: 'forked',
                    parentId: 'parent-1',
                    mutationNote: 'Added marketplace badges',
                },
            }),
            spawnCount: 0,
            isPublic: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        const parsed = parseGenomeSpec(genome);

        expect(parsed.runtimeType).toBe('claude');
        expect(parsed.lifecycle).toBe('active');
        expect(parsed.trigger?.mode).toBe('event');
        expect(parsed.behavior?.onRetire).toBe('write-handoff');
        expect(parsed.provenance?.origin).toBe('forked');
    });

    it('normalizes stringified skill arrays from malformed stored specs', () => {
        const genome: Genome = {
            id: 'genome-2',
            accountId: 'account-1',
            name: '@official/org-manager',
            parentSessionId: 'session-1',
            spec: JSON.stringify({
                namespace: '@official',
                skills: '["context-mirror", "find-skills", "brainstorming"]\nfind-skills\nbrainstorming',
                mcpServers: '["aha"]',
                allowedTools: '["Read", "Grep"]',
                disallowedTools: '["kill_agent"]',
            }),
            spawnCount: 0,
            isPublic: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        const parsed = parseGenomeSpec(genome);

        expect(parsed.skills).toEqual(['context-mirror', 'find-skills', 'brainstorming']);
        expect(parsed.mcpServers).toEqual(['aha']);
        expect(parsed.allowedTools).toEqual(['Read', 'Grep']);
        expect(parsed.disallowedTools).toEqual(['kill_agent']);
    });
});
