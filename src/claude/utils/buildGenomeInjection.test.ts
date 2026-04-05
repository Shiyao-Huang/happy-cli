import { describe, expect, it } from 'vitest';

import type { AgentImage } from '@/api/types/genome';

import { buildAgentImageInjection } from './buildGenomeInjection';

describe('buildAgentImageInjection', () => {
    it('includes runtime identity when runtimeType or lifecycle is present', () => {
        const spec: AgentImage = {
            runtimeType: 'claude',
            lifecycle: 'active',
        };

        const injection = buildAgentImageInjection(spec);

        expect(injection).toContain('## Runtime Identity');
        expect(injection).toContain('"runtimeType":"claude"');
        expect(injection).toContain('"lifecycle":"active"');
    });

    it('includes activation rules with normalized trigger conditions', () => {
        const spec: AgentImage = {
            trigger: {
                mode: 'event',
                conditions: [' build failed ', 'build failed', 'PR opened'],
            },
        };

        const injection = buildAgentImageInjection(spec);

        expect(injection).toContain('## Activation Rules');
        expect(injection).toContain('"mode":"event"');
        expect(injection).toContain('"conditions":["build failed","PR opened"]');
    });

    it('omits new sections when runtime metadata is absent', () => {
        const injection = buildAgentImageInjection({
            operations: { runtimeConfig: 'Keep context focused.' },
        });

        expect(injection).toContain('## Runtime Operating Notes');
        expect(injection).not.toContain('## Runtime Identity');
        expect(injection).not.toContain('## Activation Rules');
    });

    it('includes retire behavior in the injected role config', () => {
        const injection = buildAgentImageInjection({
            behavior: {
                onRetire: 'write-handoff',
            },
        });

        expect(injection).toContain('## Agent Role Config');
        expect(injection).toContain('"onRetire":"write-handoff"');
    });
});
