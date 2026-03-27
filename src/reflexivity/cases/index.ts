import fs from 'node:fs'
import path from 'node:path'
import { reflexivityCaseSchema, type ReflexivityCase } from '../schema'
import { projectPath } from '../../projectPath'

export const REFLEXIVITY_CASE_IDS = [
    'RFX-SELF-001',
    'RFX-ENV-001',
    'RFX-TOOL-001',
    'RFX-BOUND-001',
    'RFX-TASK-001',
    'RFX-EVAL-001',
    'RFX-LIMIT-001',
    'RFX-CONSIST-001',
] as const

function fileExists(filePath: string): boolean {
    try {
        return fs.existsSync(filePath)
    } catch {
        return false
    }
}

function walkUpForBenchmark(startDir: string): string | null {
    let current = path.resolve(startDir)
    while (true) {
        const candidate = path.join(current, 'benchmark', 'reflexivity-cases-v1.jsonl')
        if (fileExists(candidate)) return candidate
        const parent = path.dirname(current)
        if (parent === current) return null
        current = parent
    }
}

export function resolveReflexivityCasesPath(startDir?: string): string {
    // Try explicit startDir or CWD first
    const fromCwd = walkUpForBenchmark(startDir ?? process.cwd())
    if (fromCwd) return fromCwd

    // Fallback: resolve from package root (handles daemon CWD != package root)
    const fromPackage = walkUpForBenchmark(projectPath())
    if (fromPackage) return fromPackage

    throw new Error(
        'Could not locate benchmark/reflexivity-cases-v1.jsonl from CWD or package root.',
    )
}

export function parseReflexivityCasesJsonl(content: string): ReflexivityCase[] {
    const lines = content.split('\n').map((line) => line.trim()).filter(Boolean)
    return lines.map((line, index) => {
        const parsed = JSON.parse(line)
        try {
            return reflexivityCaseSchema.parse(parsed)
        } catch (error) {
            throw new Error(`Invalid reflexivity case at line ${index + 1}: ${String(error)}`)
        }
    })
}

export function loadReflexivityCases(filePath = resolveReflexivityCasesPath()): ReflexivityCase[] {
    const content = fs.readFileSync(filePath, 'utf-8')
    return parseReflexivityCasesJsonl(content)
}

export function getReflexivityCase(caseId: string, filePath = resolveReflexivityCasesPath()): ReflexivityCase {
    const found = loadReflexivityCases(filePath).find((entry) => entry.caseId === caseId)
    if (!found) {
        throw new Error(`Reflexivity case not found: ${caseId}`)
    }
    return found
}
