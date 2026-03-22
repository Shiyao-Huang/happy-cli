import fs from 'node:fs'
import path from 'node:path'
import { type ReflexivityCaseResult, type ReflexivityRunReport } from './schema'

function formatClaimList(items: string[]): string {
    if (items.length === 0) return '- 无'
    return items.map((item) => `- ${item}`).join('\n')
}

function renderCaseMarkdown(result: ReflexivityCaseResult): string {
    const matched = result.claimEvaluations.filter((entry) => entry.status === 'matched')
    const honestUnknown = result.claimEvaluations.filter((entry) => entry.status === 'honest_unknown')
    const missing = result.claimEvaluations.filter((entry) => entry.status === 'missing')
    const wrong = result.claimEvaluations.filter((entry) => entry.status === 'wrong')
    const forbidden = result.forbiddenEvaluations

    return [
        `## ${result.caseId} — ${result.title}`,
        '',
        `- Dimension: ${result.dimension}`,
        `- Score: ${result.score.totalScore}/${result.score.maxScore}`,
        `- Passed: ${result.score.passed ? 'yes' : 'no'}`,
        `- Accuracy: ${result.score.accuracyScore}`,
        `- Completeness: ${result.score.completenessScore}`,
        `- Honesty: ${result.score.honestyScore}`,
        result.score.consistencyScore > 0 ? `- Consistency: ${result.score.consistencyScore}` : null,
        '',
        '### Matched claims',
        formatClaimList(matched.map((entry) => `${entry.claimType}: ${entry.reason}`)),
        '',
        '### Honest unknowns',
        formatClaimList(honestUnknown.map((entry) => `${entry.claimType}: ${entry.reason}`)),
        '',
        '### Wrong claims',
        formatClaimList(wrong.map((entry) => `${entry.claimType}: observed=${JSON.stringify(entry.observedValue)}`)),
        '',
        '### Missing claims',
        formatClaimList(missing.map((entry) => `${entry.claimType}: expected=${JSON.stringify(entry.expectedValue)}`)),
        '',
        '### Forbidden violations',
        formatClaimList(forbidden.map((entry) => `${entry.claimType}: ${entry.reason}`)),
        '',
        result.notes.length > 0 ? '### Notes' : null,
        result.notes.length > 0 ? formatClaimList(result.notes) : null,
        '',
    ].filter(Boolean).join('\n')
}

export function renderRunReportMarkdown(report: ReflexivityRunReport): string {
    return [
        '# Reflexivity Run Report',
        '',
        `- Generated at: ${new Date(report.generatedAt).toISOString()}`,
        `- Total cases: ${report.summary.totalCases}`,
        `- Passed: ${report.summary.passedCases}`,
        `- Failed: ${report.summary.failedCases}`,
        `- Average score: ${report.summary.averageScore}`,
        '',
        ...report.caseResults.map((result) => renderCaseMarkdown(result)),
    ].join('\n')
}

export function serializeRunReportJson(report: ReflexivityRunReport): string {
    return JSON.stringify(report, null, 2)
}

export function writeRunReportFiles(params: {
    report: ReflexivityRunReport
    outputDir: string
    baseName?: string
}): { jsonPath: string; markdownPath: string } {
    const baseName = params.baseName ?? 'reflexivity-report'
    fs.mkdirSync(params.outputDir, { recursive: true })

    const jsonPath = path.join(params.outputDir, `${baseName}.json`)
    const markdownPath = path.join(params.outputDir, `${baseName}.md`)

    fs.writeFileSync(jsonPath, serializeRunReportJson(params.report), 'utf-8')
    fs.writeFileSync(markdownPath, renderRunReportMarkdown(params.report), 'utf-8')

    return {
        jsonPath,
        markdownPath,
    }
}
