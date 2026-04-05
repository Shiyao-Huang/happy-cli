import { describe, expect, it } from 'vitest';
import { buildSharedOperatingRulesSection } from './alwaysInjectedPolicies';
import { DEFAULT_ORG_RULES } from '@/orgDocker/orgRulesLoader';
import type { AgentImage } from '@/api/types/genome';

describe('buildSharedOperatingRulesSection', () => {
    it('reflects org-rules escalation, help-lane, failover, and replacement settings', () => {
        const text = buildSharedOperatingRulesSection({
            roleKey: 'builder',
            isCoordinator: false,
            isBypass: false,
            orgRules: {
                ...DEFAULT_ORG_RULES,
                escalation: {
                    ...DEFAULT_ORG_RULES.escalation,
                    blockThresholdMinutes: 12,
                },
                delegation: {
                    ...DEFAULT_ORG_RULES.delegation,
                    anyAgentCanCreateContinuationTasks: false,
                    requireMasterApprovalForNewTasks: true,
                    coordinatorRoles: ['master', 'supervisor'],
                },
                helpLane: {
                    ...DEFAULT_ORG_RULES.helpLane,
                    autoSpawnHelpAgent: false,
                    reuseIdleHelpAgents: false,
                },
                masterFailover: {
                    ...DEFAULT_ORG_RULES.masterFailover,
                    silenceThresholdMinutes: 45,
                    failoverAction: 'notify-only',
                },
                replacement: {
                    ...DEFAULT_ORG_RULES.replacement,
                    autoReplaceThreshold: 55,
                    voteRequiredAboveThreshold: 40,
                },
                taskGovernance: {
                    ...DEFAULT_ORG_RULES.taskGovernance,
                    endOfRoundChecklistEnabled: false,
                },
            },
        });

        expect(text).toContain('roughly 12 minutes');
        expect(text).toContain('does not auto-spawn help-agents from chat mentions');
        expect(text).toContain('Do not create continuation tasks on your own');
        expect(text).toContain('New tasks require Master approval before work starts');
        expect(text).toContain('Coordinator roles for this org: master, supervisor.');
        expect(text).toContain('If Master stays silent for roughly 45 minutes');
        expect(text).toContain('notify the team and surface the blockage clearly');
        expect(text).toContain('Scores below 55 should trigger an automatic replacement vote');
        expect(text).not.toContain('### End-of-Round Checklist');
    });

    it('keeps the end-of-round checklist and pooled help wording enabled by default', () => {
        const text = buildSharedOperatingRulesSection({
            roleKey: 'builder',
            isCoordinator: false,
            isBypass: false,
            orgRules: DEFAULT_ORG_RULES,
        });

        expect(text).toContain('auto-triggers help-agent spawn');
        expect(text).toContain('reusing an idle help-agent');
        expect(text).toContain('### End-of-Round Checklist');
        expect(text).toContain('call `start_task` first');
        expect(text).toContain('This checklist is enforced by org policy');
        expect(text).toContain('create the follow-up task without waiting for Master to notice');
    });

    it('injects retire handoff rules when the genome requires write-handoff on retire', () => {
        const genomeSpec: AgentImage = {
            behavior: {
                onRetire: 'write-handoff',
            },
        };

        const text = buildSharedOperatingRulesSection({
            roleKey: 'implementer',
            isCoordinator: false,
            isBypass: false,
            orgRules: DEFAULT_ORG_RULES,
            genomeSpec,
        });

        expect(text).toContain('### Retire Handoff Protocol');
        expect(text).toContain('write a handoff note');
        expect(text).toContain('`add_task_comment` with type "handoff"');
        expect(text).toContain('`retire_self.handoffNote`');
        expect(text).toContain('call `retire_self` with both a short `reason` and the mirrored `handoffNote`');
    });
});
