import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
    loadOrgRules,
    DEFAULT_ORG_RULES,
    mergeWithDefaults,
    type OrgRules,
} from './orgRulesLoader'

const TMP_DIR = join(tmpdir(), 'org-rules-test-' + Date.now())

beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true })
})

afterEach(() => {
    if (existsSync(TMP_DIR)) {
        rmSync(TMP_DIR, { recursive: true, force: true })
    }
})

describe('DEFAULT_ORG_RULES', () => {
    it('has escalation with 30-minute thresholds', () => {
        expect(DEFAULT_ORG_RULES.escalation.masterSilenceThresholdMinutes).toBe(30)
        expect(DEFAULT_ORG_RULES.escalation.blockThresholdMinutes).toBe(30)
    })

    it('has delegation with anyAgentCanCreateContinuationTasks=true', () => {
        expect(DEFAULT_ORG_RULES.delegation.anyAgentCanCreateContinuationTasks).toBe(true)
    })

    it('has masterFailover enabled', () => {
        expect(DEFAULT_ORG_RULES.masterFailover.enabled).toBe(true)
        expect(DEFAULT_ORG_RULES.masterFailover.silenceThresholdMinutes).toBe(30)
    })

    it('has taskGovernance with lockBeforeBroadcast=true', () => {
        expect(DEFAULT_ORG_RULES.taskGovernance.lockBeforeBroadcast).toBe(true)
    })

    it('has helpLane with reuseIdleHelpAgents=true', () => {
        expect(DEFAULT_ORG_RULES.helpLane.reuseIdleHelpAgents).toBe(true)
    })
})

describe('mergeWithDefaults', () => {
    it('returns defaults when called with empty object', () => {
        const merged = mergeWithDefaults({})
        expect(merged).toEqual(DEFAULT_ORG_RULES)
    })

    it('deep-merges partial escalation config', () => {
        const partial: Parameters<typeof mergeWithDefaults>[0] = {
            escalation: { masterSilenceThresholdMinutes: 60 },
        }
        const merged = mergeWithDefaults(partial)
        expect(merged.escalation.masterSilenceThresholdMinutes).toBe(60)
        // blockThresholdMinutes should remain default
        expect(merged.escalation.blockThresholdMinutes).toBe(30)
    })

    it('deep-merges partial delegation config', () => {
        const partial: Parameters<typeof mergeWithDefaults>[0] = {
            delegation: { anyAgentCanCreateContinuationTasks: false },
        }
        const merged = mergeWithDefaults(partial)
        expect(merged.delegation.anyAgentCanCreateContinuationTasks).toBe(false)
        // coordinatorRoles should remain default
        expect(merged.delegation.coordinatorRoles).toEqual(
            DEFAULT_ORG_RULES.delegation.coordinatorRoles
        )
    })

    it('does not mutate defaults', () => {
        const before = JSON.stringify(DEFAULT_ORG_RULES)
        mergeWithDefaults({ escalation: { masterSilenceThresholdMinutes: 999 } })
        const after = JSON.stringify(DEFAULT_ORG_RULES)
        expect(after).toBe(before)
    })
})

describe('loadOrgRules', () => {
    it('returns defaults when file does not exist', () => {
        const rules = loadOrgRules(join(TMP_DIR, 'nonexistent.json'))
        expect(rules).toEqual(DEFAULT_ORG_RULES)
    })

    it('parses valid org-rules.json and merges with defaults', () => {
        const configPath = join(TMP_DIR, 'org-rules.json')
        writeFileSync(configPath, JSON.stringify({
            version: '1',
            escalation: { masterSilenceThresholdMinutes: 45 },
        }))

        const rules = loadOrgRules(configPath)
        expect(rules.escalation.masterSilenceThresholdMinutes).toBe(45)
        expect(rules.escalation.blockThresholdMinutes).toBe(30) // default preserved
    })

    it('returns defaults and does not throw on invalid JSON', () => {
        const configPath = join(TMP_DIR, 'bad.json')
        writeFileSync(configPath, '{ invalid json }')
        expect(() => loadOrgRules(configPath)).not.toThrow()
        const rules = loadOrgRules(configPath)
        expect(rules).toEqual(DEFAULT_ORG_RULES)
    })

    it('ignores unknown fields (future-proof)', () => {
        const configPath = join(TMP_DIR, 'org-rules.json')
        writeFileSync(configPath, JSON.stringify({
            unknownFutureField: true,
            escalation: { masterSilenceThresholdMinutes: 20 },
        }))
        expect(() => loadOrgRules(configPath)).not.toThrow()
        const rules = loadOrgRules(configPath)
        expect(rules.escalation.masterSilenceThresholdMinutes).toBe(20)
    })

    it('clamps masterSilenceThresholdMinutes to sane range [1, 480]', () => {
        const configPath = join(TMP_DIR, 'org-rules.json')
        writeFileSync(configPath, JSON.stringify({
            escalation: { masterSilenceThresholdMinutes: 9999 },
        }))
        const rules = loadOrgRules(configPath)
        expect(rules.escalation.masterSilenceThresholdMinutes).toBeLessThanOrEqual(480)
    })

    it('clamps masterSilenceThresholdMinutes minimum to 1', () => {
        const configPath = join(TMP_DIR, 'org-rules.json')
        writeFileSync(configPath, JSON.stringify({
            escalation: { masterSilenceThresholdMinutes: 0 },
        }))
        const rules = loadOrgRules(configPath)
        expect(rules.escalation.masterSilenceThresholdMinutes).toBeGreaterThanOrEqual(1)
    })
})
