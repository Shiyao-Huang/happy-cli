import { describe, expect, it } from 'vitest';

import {
    buildCodexCustomSystemPromptBlock,
    buildCodexToolAccessInstruction,
    buildSkillsAwarenessPrompt,
    composeCodexBaseInstructions,
} from '../runtimePromptAdapter';

describe('runtimePromptAdapter', () => {
    it('builds a codex tool access contract from allow and deny lists', () => {
        const instruction = buildCodexToolAccessInstruction({
            allowedTools: ['list_tasks', 'start_task', 'list_tasks'],
            disallowedTools: ['delete_task', 'delete_task'],
        });

        expect(instruction).toContain('Allowed/preferred Aha tools: list_tasks, start_task');
        expect(instruction).toContain('Disallowed Aha tools: delete_task');
        expect(instruction).toContain('Respect this contract');
    });

    it('builds a custom system prompt wrapper when override text exists', () => {
        const block = buildCodexCustomSystemPromptBlock('Always summarize risks first.');

        expect(block).toContain('<codex_custom_system_prompt>');
        expect(block).toContain('Always summarize risks first.');
    });

    it('builds a skill awareness prompt from visible skills', () => {
        const block = buildSkillsAwarenessPrompt(['context-mirror', 'self-evolution']);

        expect(block).toContain('## Available Agent Skills');
        expect(block).toContain('- /context-mirror');
        expect(block).toContain('- /self-evolution');
    });

    it('composes codex base instructions from non-empty blocks only', () => {
        const result = composeCodexBaseInstructions([
            'First block',
            undefined,
            '',
            'Second block',
        ]);

        expect(result).toBe('First block\n\nSecond block');
    });
});
