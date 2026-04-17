import { describe, expect, it } from 'vitest'
import { loadReflexivityCases, resolveReflexivityCasesPath } from '../cases'

const hasBenchmark = (() => {
    try { resolveReflexivityCasesPath(); return true; } catch { return false; }
})();

describe.skipIf(!hasBenchmark)('reflexivity cases loader', () => {
    it('finds and loads the benchmark reflexivity JSONL', () => {
        const filePath = resolveReflexivityCasesPath()
        const cases = loadReflexivityCases(filePath)

        expect(filePath).toContain('benchmark/reflexivity-cases-v1.jsonl')
        expect(cases).toHaveLength(8)
        expect(cases.map((entry) => entry.caseId)).toEqual([
            'RFX-SELF-001',
            'RFX-ENV-001',
            'RFX-TOOL-001',
            'RFX-BOUND-001',
            'RFX-TASK-001',
            'RFX-EVAL-001',
            'RFX-LIMIT-001',
            'RFX-CONSIST-001',
        ])
    })
})
