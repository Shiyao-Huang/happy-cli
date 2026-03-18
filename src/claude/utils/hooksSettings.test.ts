import { describe, expect, it } from 'vitest'

import { buildHooksSettingsContent, hasAgentHooks } from './hooksSettings'

describe('hooksSettings', () => {
    it('returns empty settings when hooks are missing or empty', () => {
        expect(hasAgentHooks()).toBe(false)
        expect(hasAgentHooks({})).toBe(false)
        expect(buildHooksSettingsContent()).toEqual({})
        expect(buildHooksSettingsContent({
            preToolUse: [],
            postToolUse: [],
            stop: [],
        })).toEqual({})
    })

    it('builds Claude settings content for pre/post/stop hooks', () => {
        const hooks = {
            preToolUse: [
                { matcher: 'Write', command: 'echo pre-write' },
            ],
            postToolUse: [
                { matcher: 'Read', command: 'echo post-read' },
            ],
            stop: [
                { command: 'echo stop-now' },
            ],
        }

        expect(hasAgentHooks(hooks)).toBe(true)
        expect(buildHooksSettingsContent(hooks)).toEqual({
            hooks: {
                PreToolUse: [
                    {
                        matcher: 'Write',
                        hooks: [{ type: 'command', command: 'echo pre-write' }],
                    },
                ],
                PostToolUse: [
                    {
                        matcher: 'Read',
                        hooks: [{ type: 'command', command: 'echo post-read' }],
                    },
                ],
                Stop: [
                    {
                        matcher: '*',
                        hooks: [{ type: 'command', command: 'echo stop-now' }],
                    },
                ],
            },
        })
    })
})
