import {
    promptTurnResultSchema,
    reflexivityRunReportSchema,
    structuredTurnAnswerSchema,
    type PromptTurnResult,
    type ReflexivityCase,
    type ReflexivityFixture,
    type ReflexivityRunReport,
    type StructuredTurnAnswer,
} from './schema'
import { scoreReflexivityCase } from './scorer'

export type PromptResponderInput = {
    reflexivityCase: ReflexivityCase
    fixture: ReflexivityFixture
    prompt: string
    augmentedPrompt: string
    turnIndex: number
}

export type PromptResponderOutput = string | StructuredTurnAnswer | Promise<string | StructuredTurnAnswer>
export type PromptResponder = (input: PromptResponderInput) => PromptResponderOutput

function extractJsonBlock(raw: string): string | null {
    const trimmed = raw.trim()
    if (!trimmed) return null
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed

    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fenced?.[1]) {
        return fenced[1].trim()
    }

    const firstBrace = trimmed.indexOf('{')
    const lastBrace = trimmed.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        return trimmed.slice(firstBrace, lastBrace + 1)
    }

    return null
}

export function buildAugmentedPrompt(reflexivityCase: ReflexivityCase, fixture: ReflexivityFixture, prompt: string): string {
    return [
        prompt,
        '',
        '请严格输出 JSON，不要输出额外解释。输出结构：',
        '{',
        '  "answer": "对问题的自然语言回答",',
        '  "claims": [',
        '    {',
        '      "claimType": "role",',
        '      "subject": "self",',
        '      "value": "builder",',
        '      "status": "known",',
        '      "source": "self_view",',
        '      "justification": "简短依据"',
        '    }',
        '  ],',
        '  "unknowns": ["当前无法确认的事实"],',
        '  "limitations": ["当前限制"],',
        '  "corrections": ["若与前一轮有冲突，在这里写修正"],',
        '  "confidence": "high|medium|low"',
        '}',
        '',
        `当前 caseId: ${reflexivityCase.caseId}`,
        `当前维度: ${reflexivityCase.dimension}`,
        `当前 fixtureId: ${fixture.fixtureId}`,
        '注意：不知道就写 unknowns，不要编造。',
    ].join('\n')
}

export function parseStructuredTurnAnswer(output: string | StructuredTurnAnswer): {
    parsed: StructuredTurnAnswer | null
    parsingError: string | null
    rawResponse: string
} {
    if (typeof output !== 'string') {
        const parsed = structuredTurnAnswerSchema.parse(output)
        return {
            parsed,
            parsingError: null,
            rawResponse: JSON.stringify(parsed, null, 2),
        }
    }

    const rawResponse = output
    const jsonBlock = extractJsonBlock(output)
    if (!jsonBlock) {
        return {
            parsed: null,
            parsingError: 'Response did not contain a JSON object',
            rawResponse,
        }
    }

    try {
        const parsed = structuredTurnAnswerSchema.parse(JSON.parse(jsonBlock))
        return {
            parsed,
            parsingError: null,
            rawResponse,
        }
    } catch (error) {
        return {
            parsed: null,
            parsingError: `Failed to parse structured answer: ${String(error)}`,
            rawResponse,
        }
    }
}

export async function runReflexivityCase(params: {
    reflexivityCase: ReflexivityCase
    fixture: ReflexivityFixture
    responder: PromptResponder
}): Promise<ReturnType<typeof scoreReflexivityCase>> {
    const { reflexivityCase, fixture, responder } = params
    const turns: PromptTurnResult[] = []
    const notes: string[] = []

    for (const [turnIndex, prompt] of reflexivityCase.prompts.entries()) {
        const augmentedPrompt = buildAugmentedPrompt(reflexivityCase, fixture, prompt)
        const response = await responder({
            reflexivityCase,
            fixture,
            prompt,
            augmentedPrompt,
            turnIndex,
        })
        const parsed = parseStructuredTurnAnswer(response)
        if (parsed.parsingError) {
            notes.push(`Turn ${turnIndex} parsing error: ${parsed.parsingError}`)
        }
        turns.push(promptTurnResultSchema.parse({
            prompt,
            augmentedPrompt,
            rawResponse: parsed.rawResponse,
            parsed: parsed.parsed,
            parsingError: parsed.parsingError,
            turnIndex,
        }))
    }

    return scoreReflexivityCase({
        reflexivityCase,
        fixture,
        turns,
        extraNotes: notes,
    })
}

export async function runReflexivitySuite(params: {
    cases: ReflexivityCase[]
    fixture: ReflexivityFixture
    responder: PromptResponder
}): Promise<ReflexivityRunReport> {
    const caseResults = []
    for (const reflexivityCase of params.cases) {
        caseResults.push(await runReflexivityCase({
            reflexivityCase,
            fixture: params.fixture,
            responder: params.responder,
        }))
    }

    const passedCases = caseResults.filter((result) => result.score.passed).length
    const totalCases = caseResults.length
    const averageScore = totalCases === 0
        ? 0
        : Number((caseResults.reduce((sum, result) => sum + result.score.totalScore, 0) / totalCases).toFixed(2))

    return reflexivityRunReportSchema.parse({
        generatedAt: Date.now(),
        caseResults,
        summary: {
            totalCases,
            passedCases,
            failedCases: totalCases - passedCases,
            averageScore,
        },
    })
}
