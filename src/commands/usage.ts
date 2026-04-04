/**
 * CLI Command: aha usage
 *
 * Display token usage and cost data for sessions by extracting
 * cumulative totals from Claude Code session logs.
 *
 * Usage:
 *   aha usage session <sessionId>    — token/cost breakdown for a session
 *   aha usage team <teamId>          — aggregate usage across team members
 *
 * Flags:
 *   --json     Machine-readable JSON output
 *   --model    Override model for cost calculation (default: auto-detect)
 *   -h, --help Show this help
 */

import chalk from 'chalk';
import { extractTokenUsageFromCcLog } from '@/claude/utils/ccLogTokenExtractor';
import type { CcLogTokenSummary } from '@/claude/utils/ccLogTokenExtractor';

// ── Arg parsing helpers ─────────────────────────────────────────────────────

function getOption(args: string[], name: string): string | undefined {
    const flag = `--${name}`;
    const idx = args.indexOf(flag);
    if (idx === -1 || idx + 1 >= args.length) return undefined;
    return args[idx + 1];
}

function hasFlag(args: string[], ...flags: string[]): boolean {
    return flags.some((f) => args.includes(f));
}

function getPositionalArgs(args: string[]): string[] {
    const positional: string[] = [];
    const booleanFlags = new Set(['--json', '--help', '-h']);

    for (let i = 0; i < args.length; i++) {
        const val = args[i];
        if (val.startsWith('-')) {
            if (!booleanFlags.has(val) && i + 1 < args.length && !args[i + 1].startsWith('-')) {
                i++;
            }
            continue;
        }
        positional.push(val);
    }
    return positional;
}

// ── Formatting ──────────────────────────────────────────────────────────────

function formatUsd(amount: number): string {
    if (amount === 0) return '$0.00';
    if (amount < 0.01) return `$${amount.toFixed(6)}`;
    return `$${amount.toFixed(4)}`;
}

function formatTokenCount(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
}

function printSessionUsage(sessionId: string, summary: CcLogTokenSummary, modelId?: string): void {
    console.log(`\n${chalk.bold('Session Usage')} ${chalk.gray(sessionId)}`);
    if (modelId) {
        console.log(chalk.gray(`  model: ${modelId}`));
    }
    console.log(chalk.gray(`  messages: ${summary.messageCount}`));
    console.log();

    console.log(chalk.bold('  Tokens'));
    console.log(`    total:          ${chalk.cyan(formatTokenCount(summary.totalTokens))}`);
    console.log(`    input:          ${formatTokenCount(summary.tokens.input)}`);
    console.log(`    output:         ${formatTokenCount(summary.tokens.output)}`);
    if (summary.tokens.cacheCreation > 0) {
        console.log(`    cache creation: ${formatTokenCount(summary.tokens.cacheCreation)}`);
    }
    if (summary.tokens.cacheRead > 0) {
        console.log(`    cache read:     ${formatTokenCount(summary.tokens.cacheRead)}`);
    }
    console.log();

    console.log(chalk.bold('  Cost'));
    console.log(`    total:          ${chalk.yellow(formatUsd(summary.cost.total))}`);
    console.log(`    input:          ${formatUsd(summary.cost.input)}`);
    console.log(`    output:         ${formatUsd(summary.cost.output)}`);
    if (summary.cost.cacheCreation > 0) {
        console.log(`    cache creation: ${formatUsd(summary.cost.cacheCreation)}`);
    }
    if (summary.cost.cacheRead > 0) {
        console.log(`    cache read:     ${formatUsd(summary.cost.cacheRead)}`);
    }
    console.log();
}

function printTeamUsage(teamId: string, sessions: Array<{ sessionId: string; role?: string; summary: CcLogTokenSummary }>): void {
    let totalTokens = 0;
    let totalCost = 0;

    console.log(`\n${chalk.bold('Team Usage')} ${chalk.gray(teamId)}`);
    console.log(chalk.gray(`  sessions: ${sessions.length}`));
    console.log();

    for (const session of sessions) {
        const roleLabel = session.role ? chalk.cyan(`[${session.role}]`) : '';
        console.log(`  ${chalk.gray(session.sessionId)} ${roleLabel}`);
        console.log(`    tokens: ${formatTokenCount(session.summary.totalTokens)}  cost: ${chalk.yellow(formatUsd(session.summary.cost.total))}  messages: ${session.summary.messageCount}`);
        totalTokens += session.summary.totalTokens;
        totalCost += session.summary.cost.total;
    }

    console.log();
    console.log(chalk.bold('  Aggregate'));
    console.log(`    total tokens: ${chalk.cyan(formatTokenCount(totalTokens))}`);
    console.log(`    total cost:   ${chalk.yellow(formatUsd(totalCost))}`);
    console.log();
}

// ── Help ────────────────────────────────────────────────────────────────────

function showUsageHelp(): void {
    console.log(`
${chalk.bold('aha usage')} — Token usage and cost analysis

${chalk.bold('Usage:')}
  aha usage session <sessionId>      Token/cost breakdown for a session
  aha usage team <teamId>            Aggregate usage across team members

${chalk.bold('Flags:')}
  --json          Machine-readable JSON output
  --format <json|table>  Select JSON or human output mode
  --model <id>    Override model for cost calculation
  -h, --help      Show this help

${chalk.bold('Examples:')}
  ${chalk.green('aha usage session abc-123-def')}
  ${chalk.green('aha usage team my-team --json')}
  ${chalk.green('aha usage session abc-123 --model claude-opus-4-6')}
`);
}

// ── Main command handler ────────────────────────────────────────────────────

export async function handleUsageCommand(args: string[]): Promise<void> {
    const subcommand = args[0];

    if (!subcommand || subcommand === 'help' || hasFlag(args, '--help', '-h')) {
        showUsageHelp();
        return;
    }

    const positional = getPositionalArgs(args);
    const asJson = hasFlag(args, '--json');
    const modelOverride = getOption(args, 'model');

    switch (subcommand) {
        case 'session': {
            const sessionId = positional[1];
            if (!sessionId) {
                console.error(chalk.red('Usage: aha usage session <sessionId>'));
                process.exit(1);
            }

            const summary = extractTokenUsageFromCcLog(sessionId, process.env.HOME ?? undefined, modelOverride);
            if (!summary) {
                console.error(chalk.red(`Could not read CC log for session: ${sessionId}`));
                console.error(chalk.gray('Make sure the session ID is a Claude local session ID and the log file exists.'));
                process.exit(1);
            }

            if (asJson) {
                console.log(JSON.stringify({ sessionId, model: modelOverride ?? null, ...summary }, null, 2));
            } else {
                printSessionUsage(sessionId, summary, modelOverride ?? undefined);
            }
            break;
        }

        case 'team': {
            const teamId = positional[1];
            if (!teamId) {
                console.error(chalk.red('Usage: aha usage team <teamId>'));
                process.exit(1);
            }

            // Resolve team sessions via daemon
            let sessions: Array<{ ahaSessionId: string; claudeLocalSessionId?: string; role?: string }> = [];
            try {
                const { daemonPost } = await import('@/daemon/controlClient');
                const result = await daemonPost('/list-team-sessions', { teamId });
                sessions = Array.isArray(result?.sessions) ? result.sessions : [];
            } catch {
                console.error(chalk.red(`Could not list team sessions for team: ${teamId}`));
                console.error(chalk.gray('Make sure the daemon is running and the team ID is valid.'));
                process.exit(1);
            }

            if (sessions.length === 0) {
                console.log(chalk.gray('No sessions found for this team.'));
                return;
            }

            const sessionSummaries: Array<{ sessionId: string; role?: string; summary: CcLogTokenSummary }> = [];
            for (const session of sessions) {
                const ccSessionId = session.claudeLocalSessionId || session.ahaSessionId;
                const summary = extractTokenUsageFromCcLog(ccSessionId, process.env.HOME ?? undefined, modelOverride);
                if (summary) {
                    sessionSummaries.push({
                        sessionId: ccSessionId,
                        role: session.role,
                        summary,
                    });
                }
            }

            if (sessionSummaries.length === 0) {
                console.log(chalk.gray('No usage data found for any session in this team.'));
                return;
            }

            if (asJson) {
                const totalTokens = sessionSummaries.reduce((sum, s) => sum + s.summary.totalTokens, 0);
                const totalCost = sessionSummaries.reduce((sum, s) => sum + s.summary.cost.total, 0);
                console.log(JSON.stringify({
                    teamId,
                    model: modelOverride ?? null,
                    sessions: sessionSummaries,
                    aggregate: { totalTokens, totalCost: Math.round(totalCost * 1e8) / 1e8 },
                }, null, 2));
            } else {
                printTeamUsage(teamId, sessionSummaries);
            }
            break;
        }

        default:
            console.error(chalk.red(`Unknown usage subcommand: ${subcommand}`));
            showUsageHelp();
            process.exit(1);
    }
}
