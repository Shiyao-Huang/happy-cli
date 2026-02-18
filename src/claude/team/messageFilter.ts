/**
 * Message Filter Module
 *
 * Provides message classification, echo chamber suppression, and
 * credential sanitization for team collaboration messages.
 *
 * Solves:
 * - P0-2: Echo chamber (39% redundant messages → <10%)
 * - P1-3: API key leakage in team messages
 */

import { logger } from '@/ui/logger';

// === Message Classification ===

export type MessageClassification = 'actionable' | 'acknowledgment' | 'status';

/**
 * Acknowledgment patterns that indicate a message adds no value
 * and should be suppressed to prevent echo chamber effects.
 */
const ACKNOWLEDGMENT_PATTERNS = [
    /^(noted|understood|got it|roger|copy|acknowledged|received|confirmed|affirmative)\.?\s*$/i,
    /^(ok|okay|alright|sure|yes|will do|on it)\.?\s*$/i,
    /^(standing by|waiting|ready|available|online)\.?\s*$/i,
    /^(thank|thanks|thx)/i,
    /^I('m| am) (on it|ready|standing by|waiting|available)/i,
    /^(Let me|I'll) (acknowledge|note|confirm)/i,
];

/**
 * Status patterns that are informational but not actionable
 */
const STATUS_PATTERNS = [
    /^(all tasks? (are )?(complete|done|finished))/i,
    /^(awaiting|waiting for) (instructions|tasks|assignment)/i,
    /^(no (more |further )?tasks|nothing to do)/i,
    /^(status:? )?(idle|ready|free|available)/i,
    /^\[.*\] (online|ready|available|standing by)/i,
];

/**
 * Classify a message to determine if it's actionable, an acknowledgment,
 * or a status update.
 */
export function classifyMessage(content: string): MessageClassification {
    const trimmed = content.trim();

    // Short messages are more likely to be acknowledgments
    if (trimmed.length < 100) {
        for (const pattern of ACKNOWLEDGMENT_PATTERNS) {
            if (pattern.test(trimmed)) {
                return 'acknowledgment';
            }
        }

        for (const pattern of STATUS_PATTERNS) {
            if (pattern.test(trimmed)) {
                return 'status';
            }
        }
    }

    return 'actionable';
}

// === Agent Cooldown ===

interface CooldownEntry {
    lastResponse: number;
    messageCount: number;
}

export class AgentCooldown {
    private entries: Map<string, CooldownEntry> = new Map();
    private readonly cooldownMs: number;

    /**
     * @param cooldownMs - Minimum milliseconds between responses from the same agent.
     *                     Defaults to 30 seconds.
     */
    constructor(cooldownMs: number = 30_000) {
        this.cooldownMs = cooldownMs;
    }

    /**
     * Check whether an agent should respond to a message.
     *
     * Returns false if:
     * - The message is an acknowledgment (never echo acks)
     * - The agent has responded within the cooldown period
     */
    shouldRespond(agentId: string, messageType: MessageClassification): boolean {
        // Never echo acknowledgments
        if (messageType === 'acknowledgment') {
            logger.debug(`[AgentCooldown] Suppressing acknowledgment from ${agentId}`);
            return false;
        }

        const entry = this.entries.get(agentId);
        const now = Date.now();

        if (entry && (now - entry.lastResponse) < this.cooldownMs) {
            logger.debug(`[AgentCooldown] Agent ${agentId} in cooldown (${Math.round((now - entry.lastResponse) / 1000)}s < ${this.cooldownMs / 1000}s)`);
            return false;
        }

        return true;
    }

    /**
     * Record that an agent has responded.
     */
    recordResponse(agentId: string): void {
        const entry = this.entries.get(agentId);
        this.entries.set(agentId, {
            lastResponse: Date.now(),
            messageCount: (entry?.messageCount ?? 0) + 1,
        });
    }

    /**
     * Reset cooldown for a specific agent (e.g., when they receive a user message).
     */
    resetCooldown(agentId: string): void {
        this.entries.delete(agentId);
    }

    /**
     * Reset all cooldowns.
     */
    resetAll(): void {
        this.entries.clear();
    }
}

// === Credential Sanitization ===

/**
 * Patterns that match common credential formats.
 * Each entry is [pattern, description] for logging purposes.
 */
const CREDENTIAL_PATTERNS: Array<[RegExp, string]> = [
    // Anthropic / OpenAI API keys
    [/sk-[a-zA-Z0-9\-_]{20,}/g, 'API key (sk-...)'],
    [/sk-ant-[a-zA-Z0-9\-_]{20,}/g, 'Anthropic key'],

    // Auth tokens in environment variable assignments
    [/ANTHROPIC_AUTH_TOKEN=[^\s]+/g, 'ANTHROPIC_AUTH_TOKEN'],
    [/ANTHROPIC_API_KEY=[^\s]+/g, 'ANTHROPIC_API_KEY'],
    [/OPENAI_API_KEY=[^\s]+/g, 'OPENAI_API_KEY'],
    [/CLAUDE_CODE_OAUTH_TOKEN=[^\s]+/g, 'CLAUDE_CODE_OAUTH_TOKEN'],

    // Bearer tokens
    [/Bearer [a-zA-Z0-9\-._~+\/]+=*/g, 'Bearer token'],

    // GitHub tokens
    [/ghp_[a-zA-Z0-9]{36}/g, 'GitHub PAT'],
    [/gho_[a-zA-Z0-9]{36}/g, 'GitHub OAuth'],
    [/ghs_[a-zA-Z0-9]{36}/g, 'GitHub App token'],
    [/ghr_[a-zA-Z0-9]{36}/g, 'GitHub refresh token'],
    [/github_pat_[a-zA-Z0-9_]{22,}/g, 'GitHub fine-grained PAT'],

    // AWS
    [/AKIA[0-9A-Z]{16}/g, 'AWS Access Key'],

    // Generic key=value patterns for common secret names
    [/(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\s*[=:]\s*['"]?[a-zA-Z0-9\-._~+\/]{20,}['"]?/gi, 'Generic secret'],
];

/**
 * Sanitize a message by replacing credentials with [REDACTED].
 * Returns the sanitized message and the number of redactions made.
 */
export function sanitizeMessage(content: string): { sanitized: string; redactionCount: number } {
    let sanitized = content;
    let redactionCount = 0;

    for (const [pattern, description] of CREDENTIAL_PATTERNS) {
        // Reset regex state for global patterns
        pattern.lastIndex = 0;
        const matches = sanitized.match(pattern);
        if (matches) {
            redactionCount += matches.length;
            sanitized = sanitized.replace(pattern, '[REDACTED]');
            logger.debug(`[MessageFilter] Redacted ${matches.length} ${description} pattern(s)`);
        }
    }

    return { sanitized, redactionCount };
}

// === Combined Filter ===

export interface FilterResult {
    shouldProcess: boolean;
    classification: MessageClassification;
    sanitizedContent: string;
    redactionCount: number;
    reason?: string;
}

/**
 * Apply all filters to a message in one call.
 *
 * @param content - The raw message content
 * @param fromAgentId - The agent that sent the message (for cooldown)
 * @param cooldown - AgentCooldown instance to check/record
 * @param isUserMessage - Whether this message is from the human user
 */
export function filterMessage(
    content: string,
    fromAgentId: string | undefined,
    cooldown: AgentCooldown,
    isUserMessage: boolean = false,
): FilterResult {
    // Sanitize credentials first (always, regardless of classification)
    const { sanitized, redactionCount } = sanitizeMessage(content);

    // User messages always get processed (P0-1 fix)
    if (isUserMessage) {
        return {
            shouldProcess: true,
            classification: 'actionable',
            sanitizedContent: sanitized,
            redactionCount,
        };
    }

    // Classify the message
    const classification = classifyMessage(sanitized);

    // Check cooldown for agent messages
    if (fromAgentId) {
        if (!cooldown.shouldRespond(fromAgentId, classification)) {
            return {
                shouldProcess: false,
                classification,
                sanitizedContent: sanitized,
                redactionCount,
                reason: classification === 'acknowledgment'
                    ? 'Acknowledgment suppressed'
                    : `Agent ${fromAgentId} in cooldown`,
            };
        }
    }

    return {
        shouldProcess: true,
        classification,
        sanitizedContent: sanitized,
        redactionCount,
    };
}
