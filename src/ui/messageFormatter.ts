import chalk from 'chalk';
import type { SDKMessage, SDKAssistantMessage, SDKResultMessage, SDKSystemMessage, SDKUserMessage } from '@/claude/sdk';
import { logger } from './logger';
import { t } from '@/i18n';

export type OnAssistantResultCallback = (result: SDKResultMessage) => void | Promise<void>;

/**
 * Formats Claude SDK messages for terminal display
 */
export function formatClaudeMessage(
    message: SDKMessage,
    onAssistantResult?: OnAssistantResultCallback
): void {
    logger.debugLargeJson('[CLAUDE] Message from non interactive & remote mode:', message)

    switch (message.type) {
        case 'system': {
            const sysMsg = message as SDKSystemMessage;
            if (sysMsg.subtype === 'init') {
                console.log(chalk.gray('─'.repeat(60)));
                console.log(chalk.blue.bold(t('formatter.sessionInit')), chalk.cyan(sysMsg.session_id));
                console.log(chalk.gray(t('formatter.model', { model: sysMsg.model ?? '' })));
                console.log(chalk.gray(t('formatter.cwd', { cwd: sysMsg.cwd ?? '' })));
                if (sysMsg.tools && sysMsg.tools.length > 0) {
                    console.log(chalk.gray(t('formatter.tools', { tools: sysMsg.tools.join(', ') })));
                }
                console.log(chalk.gray('─'.repeat(60)));
            }
            break;
        }

        case 'user': {
            const userMsg = message as SDKUserMessage;
            // Handle different types of user message content
            if (userMsg.message && typeof userMsg.message === 'object' && 'content' in userMsg.message) {
                const content = userMsg.message.content;

                // Handle string content
                if (typeof content === 'string') {
                    console.log(chalk.magenta.bold(t('formatter.user')), content);
                }
                // Handle array content (can contain text blocks and tool result blocks)
                else if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block.type === 'text') {
                            console.log(chalk.magenta.bold(t('formatter.user')), block.text);
                        } else if (block.type === 'tool_result') {
                            console.log(chalk.green.bold(t('formatter.toolResult')), chalk.gray(t('formatter.toolId', { id: block.tool_use_id ?? '' })));
                            if (block.content) {
                                const outputStr = typeof block.content === 'string'
                                    ? block.content
                                    : JSON.stringify(block.content, null, 2);
                                const maxLength = 200;
                                if (outputStr.length > maxLength) {
                                    console.log(outputStr.substring(0, maxLength) + chalk.gray(t('formatter.truncated')));
                                } else {
                                    console.log(outputStr);
                                }
                            }
                        }
                    }
                }
                // Handle other content types
                else {
                    console.log(chalk.magenta.bold(t('formatter.user')), JSON.stringify(content, null, 2));
                }
            }
            break;
        }

        case 'assistant': {
            const assistantMsg = message as SDKAssistantMessage;
            if (assistantMsg.message && assistantMsg.message.content) {
                console.log(chalk.cyan.bold(t('formatter.assistant')));

                // Handle content array (can contain text blocks and tool use blocks)
                for (const block of assistantMsg.message.content) {
                    if (block.type === 'text') {
                        console.log(block.text);
                    } else if (block.type === 'tool_use') {
                        console.log(chalk.yellow.bold(t('formatter.tool', { name: block.name ?? '' })));
                        if (block.input) {
                            const inputStr = JSON.stringify(block.input, null, 2);
                            const maxLength = 500;
                            if (inputStr.length > maxLength) {
                                console.log(chalk.gray(t('formatter.input')), inputStr.substring(0, maxLength) + chalk.gray(t('formatter.truncated')));
                            } else {
                                console.log(chalk.gray(t('formatter.input')), inputStr);
                            }
                        }
                    }
                }
            }
            break;
        }

        case 'result': {
            const resultMsg = message as SDKResultMessage;
            if (resultMsg.subtype === 'success') {
                if ('result' in resultMsg && resultMsg.result) {
                    console.log(chalk.green.bold(t('formatter.summary')));
                    console.log(resultMsg.result);
                }

                // Show usage stats
                if (resultMsg.usage) {
                    console.log(chalk.gray(t('formatter.sessionStats')));
                    console.log(chalk.gray(t('formatter.turns', { count: resultMsg.num_turns })));
                    console.log(chalk.gray(t('formatter.inputTokens', { count: resultMsg.usage.input_tokens })));
                    console.log(chalk.gray(t('formatter.outputTokens', { count: resultMsg.usage.output_tokens })));
                    if (resultMsg.usage.cache_read_input_tokens) {
                        console.log(chalk.gray(t('formatter.cacheReadTokens', { count: resultMsg.usage.cache_read_input_tokens })));
                    }
                    if (resultMsg.usage.cache_creation_input_tokens) {
                        console.log(chalk.gray(t('formatter.cacheCreationTokens', { count: resultMsg.usage.cache_creation_input_tokens })));
                    }
                    console.log(chalk.gray(t('formatter.cost', { cost: resultMsg.total_cost_usd.toFixed(4) })));
                    console.log(chalk.gray(t('formatter.duration', { ms: resultMsg.duration_ms })));

                    // Show instructions how to take over terminal control
                    console.log(chalk.gray(t('formatter.backAlready')));
                    console.log(chalk.green(t('formatter.pressAnyKey')));

                    // Call the assistant result callback after showing instructions
                    if (onAssistantResult) {
                        Promise.resolve(onAssistantResult(resultMsg)).catch(err => {
                            logger.debug('Error in onAssistantResult callback:', err);
                        });
                    }
                }
            } else if (resultMsg.subtype === 'error_max_turns') {
                console.log(chalk.red.bold(t('formatter.maxTurnsError')));
                console.log(chalk.gray(t('formatter.completedTurns', { count: resultMsg.num_turns })));
            } else if (resultMsg.subtype === 'error_during_execution') {
                console.log(chalk.red.bold(t('formatter.executionError')));
                console.log(chalk.gray(t('formatter.completedTurns', { count: resultMsg.num_turns })));
                logger.debugLargeJson('[RESULT] Error during execution', resultMsg)
            }
            break;
        }

        default: {
            // Handle other message types
            if (process.env.DEBUG) {
                console.log(chalk.gray(t('formatter.unknownType', { type: message.type })));
            }
        }
    }
}

/**
 * Prints a divider in the terminal
 */
export function printDivider(): void {
    console.log(chalk.gray('═'.repeat(60)));
}

/**
 * Prints a status message
 */
export function printStatus(message: string): void {
    console.log(chalk.blue.bold(`ℹ️  ${message}`));
}
