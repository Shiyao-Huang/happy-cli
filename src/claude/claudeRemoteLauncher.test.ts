import { describe, expect, it } from 'vitest';

import { extractLifecycleDirectiveFromContent } from './claudeRemoteLauncher';

describe('extractLifecycleDirectiveFromContent', () => {
    it('extracts an explicit retire directive from a text block array', () => {
        const directive = extractLifecycleDirectiveFromContent([
            { type: 'text', text: 'Work complete.\n<AHA_LIFECYCLE action="retire" reason="help_complete" />' },
        ]);

        expect(directive).toEqual({
            action: 'retire',
            reason: 'help_complete',
            rawText: '<AHA_LIFECYCLE action="retire" reason="help_complete" />',
        });
    });

    it('extracts standby directives from plain string content', () => {
        const directive = extractLifecycleDirectiveFromContent(
            'Entering silent standby.\n<AHA_LIFECYCLE action="standby" reason="hr_standby" />'
        );

        expect(directive).toEqual({
            action: 'standby',
            reason: 'hr_standby',
            rawText: '<AHA_LIFECYCLE action="standby" reason="hr_standby" />',
        });
    });

    it('ignores legacy completion words without an explicit lifecycle directive', () => {
        const directive = extractLifecycleDirectiveFromContent([
            { type: 'text', text: 'The help-agent reported HELP_COMPLETE earlier, but I am staying alive.' },
        ]);

        expect(directive).toBeNull();
    });
});
