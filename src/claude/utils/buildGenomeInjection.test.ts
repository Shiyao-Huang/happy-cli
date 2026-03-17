import { describe, expect, it } from 'vitest';

import type { GenomeSpec } from '@/api/types/genome';

import { buildGenomeInjection } from './buildGenomeInjection';

describe('buildGenomeInjection', () => {
    it('includes runtime identity when runtimeType or lifecycle is present', () => {
        const spec: GenomeSpec = {
            runtimeType: 'claude',
            lifecycle: 'active',
        };

        const injection = buildGenomeInjection(spec);

        expect(injection).toContain('## Runtime Identity');
        expect(injection).toContain('"runtimeType":"claude"');
        expect(injection).toContain('"lifecycle":"active"');
    });

    it('includes activation rules with normalized trigger conditions', () => {
        const spec: GenomeSpec = {
            trigger: {
                mode: 'event',
                conditions: [' build failed ', 'build failed', 'PR opened'],
            },
        };

        const injection = buildGenomeInjection(spec);

        expect(injection).toContain('## Activation Rules');
        expect(injection).toContain('"mode":"event"');
        expect(injection).toContain('"conditions":["build failed","PR opened"]');
    });

    it('omits new sections when runtime metadata is absent', () => {
        const injection = buildGenomeInjection({
            operations: { runtimeConfig: 'Keep context focused.' },
        });

        expect(injection).toContain('## Runtime Operating Notes');
        expect(injection).not.toContain('## Runtime Identity');
        expect(injection).not.toContain('## Activation Rules');
    });
});
