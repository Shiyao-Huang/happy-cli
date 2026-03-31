/**
 * org-rules.json Loader — L2 Org Docker Config Layer
 *
 * Org rules define team-level escalation, delegation, and governance policies.
 * They replace hardcoded thresholds in alwaysInjectedPolicies, making the
 * organizational structure JSON config-driven and therefore LLM-evolvable via
 * evolve_genome / mutate_genome.
 *
 * Resolution order:
 *   1. Explicit filePath argument (for testing / custom paths)
 *   2. $AHA_HOME_DIR/org-rules.json
 *   3. DEFAULT_ORG_RULES (built-in fallback)
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EscalationConfig {
    /** Minutes of Master silence before lower-layer agents MUST act (default: 30) */
    masterSilenceThresholdMinutes: number
    /** Minutes blocked before an agent MUST call request_help (default: 30) */
    blockThresholdMinutes: number
    /** Minutes before a stale approval request is escalated (default: 60) */
    approvalTimeoutMinutes: number
    /** Auto-escalate when board is empty and agents appear idle (default: true) */
    autoEscalateOnIdleBoard: boolean
}

export interface DelegationConfig {
    /** Any agent can create continuation tasks without Master approval (default: true) */
    anyAgentCanCreateContinuationTasks: boolean
    /** Roles treated as coordinators with elevated permissions */
    coordinatorRoles: string[]
    /** Require Master approval before any new task can be started (default: false) */
    requireMasterApprovalForNewTasks: boolean
    /**
     * Roles that may bypass normal approval/permission gates when Master is unresponsive.
     * These roles can act without waiting for Master sign-off during failover scenarios.
     * (default: ["supervisor", "org-manager"])
     */
    bypassRoleIds: string[]
}

export interface HelpLaneConfig {
    /** Automatically spawn help-agent on @help mention (default: true) */
    autoSpawnHelpAgent: boolean
    /** Max concurrent help-agent instances (default: 2) */
    helpAgentMaxInstances: number
    /** Reuse idle help-agents instead of spawning new ones (default: true) */
    reuseIdleHelpAgents: boolean
}

export interface TaskGovernanceConfig {
    /** Lock task (start_task) before broadcasting assignment to agents (default: true) */
    lockBeforeBroadcast: boolean
    /** Require start_task call before any work begins (default: true) */
    requireStartBeforeWork: boolean
    /** Enforce end-of-round checklist after complete_task (default: true) */
    endOfRoundChecklistEnabled: boolean
}

export interface MasterFailoverConfig {
    /** Enable automatic Master failover detection (default: true) */
    enabled: boolean
    /** Minutes of Master silence before failover triggers (default: 30) */
    silenceThresholdMinutes: number
    /**
     * Minutes of Master silence before Supervisor MUST auto-override and take control.
     * Sprint 0325 learning: Master was silent 2h+, 13 agents waited 113 min with no
     * auto-intervention. Set this lower than silenceThresholdMinutes + recovery time.
     * (default: 60)
     */
    supervisorOverrideTimeoutMinutes: number
    /**
     * Action on failover:
     * - "create-continuation-tasks": agents create tasks to unblock themselves
     * - "notify-only": just send team message
     */
    failoverAction: 'create-continuation-tasks' | 'notify-only'
    /** Notify the team when failover is triggered (default: true) */
    notifyOnFailover: boolean
}

export interface ReplacementConfig {
    /** Auto-replacement threshold — score below this triggers vote (default: 60) */
    autoReplaceThreshold: number
    /** Vote required if score is above this (default: 40) */
    voteRequiredAboveThreshold: number
}

export interface OrgRules {
    version?: string
    escalation: EscalationConfig
    delegation: DelegationConfig
    helpLane: HelpLaneConfig
    taskGovernance: TaskGovernanceConfig
    masterFailover: MasterFailoverConfig
    replacement: ReplacementConfig
}

type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends Array<infer U>
        ? U[]
        : T[K] extends ReadonlyArray<infer U>
            ? ReadonlyArray<U>
            : T[K] extends object
                ? DeepPartial<T[K]>
                : T[K]
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults — Sprint 0325 Wave 2 learnings
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_ORG_RULES: Readonly<OrgRules> = Object.freeze({
    version: '1',
    escalation: Object.freeze({
        masterSilenceThresholdMinutes: 30,
        blockThresholdMinutes: 30,
        approvalTimeoutMinutes: 60,
        autoEscalateOnIdleBoard: true,
    }),
    delegation: Object.freeze({
        anyAgentCanCreateContinuationTasks: true,
        coordinatorRoles: ['orchestrator', 'master', 'supervisor', 'org-manager'],
        requireMasterApprovalForNewTasks: false,
        bypassRoleIds: ['supervisor', 'org-manager'],
    }),
    helpLane: Object.freeze({
        autoSpawnHelpAgent: true,
        helpAgentMaxInstances: 2,
        reuseIdleHelpAgents: true,
    }),
    taskGovernance: Object.freeze({
        lockBeforeBroadcast: true,
        requireStartBeforeWork: true,
        endOfRoundChecklistEnabled: true,
    }),
    masterFailover: Object.freeze({
        enabled: true,
        silenceThresholdMinutes: 30,
        supervisorOverrideTimeoutMinutes: 60,
        failoverAction: 'create-continuation-tasks',
        notifyOnFailover: true,
    }),
    replacement: Object.freeze({
        autoReplaceThreshold: 60,
        voteRequiredAboveThreshold: 40,
    }),
})

// ─────────────────────────────────────────────────────────────────────────────
// Deep merge — preserves defaults for any missing keys
// ─────────────────────────────────────────────────────────────────────────────

export function mergeWithDefaults(partial: DeepPartial<OrgRules>): OrgRules {
    return {
        version: partial.version ?? DEFAULT_ORG_RULES.version,
        escalation: { ...DEFAULT_ORG_RULES.escalation, ...partial.escalation },
        delegation: { ...DEFAULT_ORG_RULES.delegation, ...partial.delegation },
        helpLane: { ...DEFAULT_ORG_RULES.helpLane, ...partial.helpLane },
        taskGovernance: { ...DEFAULT_ORG_RULES.taskGovernance, ...partial.taskGovernance },
        masterFailover: { ...DEFAULT_ORG_RULES.masterFailover, ...partial.masterFailover },
        replacement: { ...DEFAULT_ORG_RULES.replacement, ...partial.replacement },
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation — clamp numeric values to sane ranges
// ─────────────────────────────────────────────────────────────────────────────

function clampMinutes(value: number, min = 1, max = 480): number {
    return Math.min(Math.max(Math.round(value), min), max)
}

function validateAndClamp(rules: OrgRules): OrgRules {
    return {
        ...rules,
        escalation: {
            ...rules.escalation,
            masterSilenceThresholdMinutes: clampMinutes(rules.escalation.masterSilenceThresholdMinutes),
            blockThresholdMinutes: clampMinutes(rules.escalation.blockThresholdMinutes),
            approvalTimeoutMinutes: clampMinutes(rules.escalation.approvalTimeoutMinutes, 1, 1440),
        },
        masterFailover: {
            ...rules.masterFailover,
            silenceThresholdMinutes: clampMinutes(rules.masterFailover.silenceThresholdMinutes),
        },
        helpLane: {
            ...rules.helpLane,
            helpAgentMaxInstances: Math.min(Math.max(rules.helpLane.helpAgentMaxInstances, 1), 10),
        },
        replacement: {
            autoReplaceThreshold: clampMinutes(rules.replacement.autoReplaceThreshold, 0, 100),
            voteRequiredAboveThreshold: clampMinutes(rules.replacement.voteRequiredAboveThreshold, 0, 100),
        },
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load org-rules.json from an explicit path, or fall back to
 * $AHA_HOME_DIR/org-rules.json, or DEFAULT_ORG_RULES.
 */
export function loadOrgRules(explicitPath?: string): OrgRules {
    const candidates: string[] = []

    if (explicitPath) {
        candidates.push(explicitPath)
    } else {
        const ahaHome = process.env.AHA_HOME_DIR ?? join(
            process.env.HOME ?? process.env.USERPROFILE ?? '',
            '.aha'
        )
        candidates.push(join(ahaHome, 'org-rules.json'))
    }

    for (const candidate of candidates) {
        if (!existsSync(candidate)) continue
        try {
            const raw = readFileSync(candidate, 'utf-8')
            const parsed = JSON.parse(raw) as Partial<OrgRules>
            const merged = mergeWithDefaults(parsed)
            return validateAndClamp(merged)
        } catch {
            // Invalid JSON or read error — fall through to defaults
        }
    }

    return { ...DEFAULT_ORG_RULES } as OrgRules
}
