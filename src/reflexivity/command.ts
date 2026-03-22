import fs from 'node:fs'
import chalk from 'chalk'
import { getOption, parseFlags } from '@/commands/parseFlags'
import { renderResult, runSubcommand } from '@/commands/output'
import type { CommandContext, CommandResult, SubcommandEntry } from '@/commands/types'
import { buildReflexivityFixture } from './fixtures'
import { getReflexivityCase, loadReflexivityCases } from './cases'
import { renderRunReportMarkdown, serializeRunReportJson, writeRunReportFiles } from './reporter'
import { scoreReflexivityCase } from './scorer'
import {
    promptTurnResultSchema,
    reflexivityFixtureSchema,
    structuredTurnAnswerSchema,
    type PromptTurnResult,
} from './schema'

function readJsonFile(filePath: string): unknown {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
}

function buildTurnsFromResponsePayload(payload: unknown, prompts: string[]): PromptTurnResult[] {
    const items = Array.isArray(payload)
        ? payload
        : payload && typeof payload === 'object' && Array.isArray((payload as any).turns)
            ? (payload as any).turns
            : [payload]

    return items.map((item: unknown, index: number) => {
        if (item && typeof item === 'object' && 'prompt' in (item as any) && 'rawResponse' in (item as any)) {
            return promptTurnResultSchema.parse(item)
        }

        const parsed = structuredTurnAnswerSchema.parse(item)
        return promptTurnResultSchema.parse({
            prompt: prompts[index] ?? prompts[prompts.length - 1] ?? `turn-${index}`,
            augmentedPrompt: prompts[index] ?? prompts[prompts.length - 1] ?? `turn-${index}`,
            rawResponse: JSON.stringify(parsed, null, 2),
            parsed,
            parsingError: null,
            turnIndex: index,
        })
    })
}

export async function listCasesCommand(_ctx: CommandContext): Promise<CommandResult<Array<Record<string, unknown>>>> {
    const cases = loadReflexivityCases().map((entry) => ({
        caseId: entry.caseId,
        title: entry.title,
        dimension: entry.dimension,
        interactionMode: entry.interactionMode,
        promptCount: entry.prompts.length,
        passThreshold: entry.scoring.passThreshold,
    }))

    return {
        ok: true,
        message: `Loaded ${cases.length} reflexivity cases`,
        data: cases,
        detail: cases.map((entry) => `${entry.caseId} (${entry.dimension})`).join(', '),
    }
}

export async function fixtureExampleCommand(_ctx: CommandContext): Promise<CommandResult<Record<string, unknown>>> {
    const fixture = buildReflexivityFixture({
        fixtureId: 'fixture-example',
        collectedAt: 1774165000000,
        context: {
            teamId: 'team-example',
            sessionId: 'session-example',
            runtimeType: 'codex',
        },
        snapshots: {
            identitySnapshot: {
                role: 'builder',
                teamName: '能力检测',
            },
            taskSnapshot: {
                primary: {
                    taskId: 'task-1',
                    title: '实现自反性检测核心逻辑',
                    status: 'in-progress',
                    priority: 'high',
                    taskType: 'implementation',
                    inputs: ['设计文档', 'case JSONL'],
                    outputs: ['runner', 'scorer', 'reporter'],
                    acceptanceCriteria: ['测试通过', '报告可生成'],
                    currentSlice: 'Phase 1',
                    nextAction: '实现 CLI 接线',
                },
            },
            environmentSnapshot: {
                cwd: '/Users/swmt/happy0313',
                blindSpots: ['其他 agent 正在修改的文件'],
                requiresProbe: ['context status', 'effective permissions'],
            },
        },
    })

    return {
        ok: true,
        message: 'Generated example reflexivity fixture',
        data: fixture as unknown as Record<string, unknown>,
    }
}

export async function scoreCaseCommand(ctx: CommandContext): Promise<CommandResult<Record<string, unknown>>> {
    const caseId = getOption(ctx.flags, 'case')
    const fixturePath = getOption(ctx.flags, 'fixture')
    const responsePath = getOption(ctx.flags, 'response')
    const outputDir = getOption(ctx.flags, 'out')

    if (!caseId || !fixturePath || !responsePath) {
        return {
            ok: false,
            message: 'Missing required flags for score command',
            error: {
                code: 'INVALID_ARGUMENTS',
                message: 'Usage: aha reflexivity score --case <id> --fixture <fixture.json> --response <response.json>',
                hint: 'Optional: --out <dir> to write JSON + Markdown report files',
            },
        }
    }

    const reflexivityCase = getReflexivityCase(caseId)
    const fixture = reflexivityFixtureSchema.parse(readJsonFile(fixturePath))
    const turns = buildTurnsFromResponsePayload(readJsonFile(responsePath), reflexivityCase.prompts)
    const result = scoreReflexivityCase({
        reflexivityCase,
        fixture,
        turns,
    })

    let artifacts: { jsonPath: string; markdownPath: string } | null = null
    if (outputDir) {
        artifacts = writeRunReportFiles({
            report: {
                generatedAt: Date.now(),
                caseResults: [result],
                summary: {
                    totalCases: 1,
                    passedCases: result.score.passed ? 1 : 0,
                    failedCases: result.score.passed ? 0 : 1,
                    averageScore: result.score.totalScore,
                },
            },
            outputDir,
            baseName: caseId.toLowerCase(),
        })
    }

    return {
        ok: true,
        message: `${caseId} scored ${result.score.totalScore}/${result.score.maxScore}`,
        data: {
            caseId,
            score: result.score,
            artifacts,
            markdown: outputDir ? undefined : renderRunReportMarkdown({
                generatedAt: Date.now(),
                caseResults: [result],
                summary: {
                    totalCases: 1,
                    passedCases: result.score.passed ? 1 : 0,
                    failedCases: result.score.passed ? 0 : 1,
                    averageScore: result.score.totalScore,
                },
            }),
            json: outputDir ? undefined : JSON.parse(serializeRunReportJson({
                generatedAt: Date.now(),
                caseResults: [result],
                summary: {
                    totalCases: 1,
                    passedCases: result.score.passed ? 1 : 0,
                    failedCases: result.score.passed ? 0 : 1,
                    averageScore: result.score.totalScore,
                },
            })),
        },
        detail: artifacts
            ? `JSON: ${artifacts.jsonPath}\nMarkdown: ${artifacts.markdownPath}`
            : undefined,
    }
}

export function showReflexivityHelp(): void {
    console.log(`
${chalk.bold.cyan('Aha Reflexivity')}

Usage:
  ${chalk.green('aha reflexivity cases')}                     List bundled reflexivity cases
  ${chalk.green('aha reflexivity fixture-example')}           Print an example fixture JSON
  ${chalk.green('aha reflexivity score')} ${chalk.cyan('--case <id> --fixture <file> --response <file> [--out <dir>]')}
`)
}

export const REFLEXIVITY_COMMANDS: Record<string, SubcommandEntry> = {
    cases: {
        handler: listCasesCommand,
        description: 'List bundled reflexivity cases',
    },
    'fixture-example': {
        handler: fixtureExampleCommand,
        description: 'Generate an example fixture payload',
    },
    score: {
        handler: scoreCaseCommand,
        description: 'Score a case against a fixture + structured response file',
        usage: '--case <id> --fixture <file> --response <file> [--out <dir>]',
    },
}

export async function handleReflexivityCommand(args: string[]): Promise<void> {
    const sub = args[0]
    const flags = parseFlags(args.slice(1))
    if (!sub || sub === 'help' || flags.help) {
        showReflexivityHelp()
        return
    }
    await runSubcommand('Aha Reflexivity', 'reflexivity', REFLEXIVITY_COMMANDS, args)
}

export { buildTurnsFromResponsePayload }
