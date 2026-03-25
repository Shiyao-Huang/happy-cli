/**
 * Parsers for special commands that require dedicated remote session handling
 */

export interface ClearCommandResult {
    isClear: boolean;
}

export interface SpecialCommandResult {
    type: 'clear' | null;
    originalMessage?: string;
}

/**
 * Parse /clear command
 * Only matches exactly "/clear"
 */
export function parseClear(message: string): ClearCommandResult {
    const trimmed = message.trim();

    return {
        isClear: trimmed === '/clear'
    };
}

/**
 * Unified parser for special commands
 * Returns the type of command and original message if applicable
 */
export function parseSpecialCommand(message: string): SpecialCommandResult {
    const clearResult = parseClear(message);
    if (clearResult.isClear) {
        return {
            type: 'clear'
        };
    }

    return {
        type: null
    };
}
