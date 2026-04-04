import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

import { getDefaultClaudeCodePath } from './utils'

describe('claude sdk utils', () => {
    it('resolves the default Claude Code executable via Node module resolution', () => {
        const require = createRequire(import.meta.url)
        const resolved = require.resolve('@anthropic-ai/claude-code/cli.js')

        expect(getDefaultClaudeCodePath()).toBe(resolved)
        expect(existsSync(resolved)).toBe(true)
    })
})
