import { describe, expect, it } from 'vitest';
import {
    buildMissingTeamContextInstruction,
    buildTeamFallbackInstruction,
    buildTeamStartupContext,
    containsHelpMention,
    getHelpLaneGuidance,
    shouldAutoEscalateIncomingHelpMessage,
    toHelpSeverity,
} from './helpLane';

describe('helpLane helpers', () => {
    it('detects @help at the start or in the middle of a message', () => {
        expect(containsHelpMention('@help I am blocked')).toBe(true);
        expect(containsHelpMention('Master, @help I am blocked')).toBe(true);
        expect(containsHelpMention('Need (@help) for this env issue')).toBe(true);
    });

    it('does not confuse emails or plain text with @help escalation', () => {
        expect(containsHelpMention('contact help@example.com')).toBe(false);
        expect(containsHelpMention('please help with this')).toBe(false);
        expect(containsHelpMention('foo@helper')).toBe(false);
    });

    it('maps message priority to help severity', () => {
        expect(toHelpSeverity('urgent')).toBe('critical');
        expect(toHelpSeverity('high')).toBe('high');
        expect(toHelpSeverity('low')).toBe('low');
        expect(toHelpSeverity(undefined)).toBe('medium');
    });

    it('builds startup and fallback instructions with explicit help-lane awareness', () => {
        expect(buildTeamStartupContext('team-123', 'implementer')).toContain('request_help');
        expect(buildTeamStartupContext('team-123', 'implementer')).toContain('@help');
        expect(buildTeamFallbackInstruction('implementer')).toContain('request_help');
        expect(buildMissingTeamContextInstruction()).toContain('functions.aha__get_team_info');
        expect(getHelpLaneGuidance().join('\n')).toContain('@help');
    });

    it('auto-escalates incoming help messages except for self/help-agent chatter', () => {
        expect(shouldAutoEscalateIncomingHelpMessage({
            content: 'User says @help please',
            fromRole: 'user',
            fromSessionId: 'user-session',
        }, 'agent-session')).toBe(true);

        expect(shouldAutoEscalateIncomingHelpMessage({
            content: '@help already on it',
            fromRole: 'help-agent',
            fromSessionId: 'help-session',
        }, 'agent-session')).toBe(false);

        expect(shouldAutoEscalateIncomingHelpMessage({
            content: '@help I sent this myself',
            fromRole: 'implementer',
            fromSessionId: 'agent-session',
        }, 'agent-session')).toBe(false);
    });
});
