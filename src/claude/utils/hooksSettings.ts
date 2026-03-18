export interface AgentHookEntry {
    matcher: string
    command: string
    description?: string
}

export interface AgentStopHookEntry {
    command: string
    description?: string
}

export interface AgentHooks {
    preToolUse?: AgentHookEntry[]
    postToolUse?: AgentHookEntry[]
    stop?: AgentStopHookEntry[]
}

interface ClaudeCommandHook {
    type: 'command'
    command: string
}

interface ClaudeHookMatcher {
    matcher: string
    hooks: ClaudeCommandHook[]
}

export interface ClaudeHooksSettingsContent {
    hooks?: {
        PreToolUse?: ClaudeHookMatcher[]
        PostToolUse?: ClaudeHookMatcher[]
        Stop?: ClaudeHookMatcher[]
    }
}

export function hasAgentHooks(hooks?: AgentHooks | null): boolean {
    if (!hooks) return false

    return (hooks.preToolUse?.length ?? 0) > 0
        || (hooks.postToolUse?.length ?? 0) > 0
        || (hooks.stop?.length ?? 0) > 0
}

function toCommandHook(command: string): ClaudeCommandHook {
    return {
        type: 'command',
        command,
    }
}

export function buildHooksSettingsContent(hooks?: AgentHooks | null): ClaudeHooksSettingsContent {
    if (!hooks) return {}

    const hooksConfig: NonNullable<ClaudeHooksSettingsContent['hooks']> = {}

    if (hooks.preToolUse?.length) {
        hooksConfig.PreToolUse = hooks.preToolUse.map((hook) => ({
            matcher: hook.matcher,
            hooks: [toCommandHook(hook.command)],
        }))
    }

    if (hooks.postToolUse?.length) {
        hooksConfig.PostToolUse = hooks.postToolUse.map((hook) => ({
            matcher: hook.matcher,
            hooks: [toCommandHook(hook.command)],
        }))
    }

    if (hooks.stop?.length) {
        hooksConfig.Stop = hooks.stop.map((hook) => ({
            matcher: '*',
            hooks: [toCommandHook(hook.command)],
        }))
    }

    return Object.keys(hooksConfig).length > 0
        ? { hooks: hooksConfig }
        : {}
}
