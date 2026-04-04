import { describe, expect, it } from 'vitest'

import { projectPath } from '@/projectPath'

import { getDefaultClaudeCodePath } from './utils'

describe('claude sdk utils', () => {
    it('resolves the default Claude Code executable from the repo root', () => {
        expect(getDefaultClaudeCodePath()).toBe(
            `${projectPath()}/node_modules/@anthropic-ai/claude-code/cli.js`
        )
    })
})
