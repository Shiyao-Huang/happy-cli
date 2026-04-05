import { describe, expect, it } from 'vitest';

import {
    buildApiRetryDiagnosticMessage,
    extractAnthropicBaseUrlHost,
    extractLifecycleDirectiveFromContent,
} from './claudeRemoteLauncher';

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

describe('extractAnthropicBaseUrlHost', () => {
    it('returns host for valid base url', () => {
        expect(extractAnthropicBaseUrlHost('http://168.231.73.244:8081')).toBe('168.231.73.244:8081');
    });

    it('returns null for invalid base url', () => {
        expect(extractAnthropicBaseUrlHost('not-a-url')).toBeNull();
    });
});

describe('buildApiRetryDiagnosticMessage', () => {
    it('explains custom relay exhaustion when 502 retries are exhausted', () => {
        const message = buildApiRetryDiagnosticMessage({
            type: 'system',
            subtype: 'api_retry',
            attempt: 10,
            max_retries: 10,
            error_status: 502,
            error: 'server_error',
        } as any, 'http://168.231.73.244:8081');

        expect(message).toContain('自定义 relay 168.231.73.244:8081');
    });

    it('does not emit a diagnostic before retries are exhausted', () => {
        const message = buildApiRetryDiagnosticMessage({
            type: 'system',
            subtype: 'api_retry',
            attempt: 3,
            max_retries: 10,
            error_status: 502,
            error: 'server_error',
        } as any, 'http://168.231.73.244:8081');

        expect(message).toBeNull();
    });

    it('treats Anthropic first-party host as upstream instead of custom relay', () => {
        const message = buildApiRetryDiagnosticMessage({
            type: 'system',
            subtype: 'api_retry',
            attempt: 10,
            max_retries: 10,
            error_status: 502,
            error: 'server_error',
        } as any, 'https://api.anthropic.com');

        expect(message).toContain('api.anthropic.com');
        expect(message).not.toContain('自定义 relay');
    });
});
