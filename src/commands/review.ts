/**
 * review.ts — `aha review` command
 *
 * Triggers a code review via the happy-server Code Review Gateway (R12).
 *
 * Usage:
 *   aha review                         # Review current branch (HEAD)
 *   aha review --pr <url>              # Review a specific PR URL
 *   aha review --focus security        # Focus on security findings
 *   aha review --team <teamId>         # Specify team (otherwise first team is used)
 *   aha review --json                  # Output raw JSON result
 *
 * The command starts the review job, polls for completion, then prints
 * findings sorted by severity.  Exit code 1 if critical findings are found.
 */

import chalk from 'chalk';
import { readCredentials } from '@/persistence';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FocusArea = 'all' | 'security' | 'performance' | 'style' | 'logic';

interface ReviewJob {
    reviewJobId: string;
    teamId: string;
    status: string;
    prUrl?: string;
    branch?: string;
    focus: FocusArea[];
    assignedAgent: string | null;
    estimatedTime: number;
    createdAt: string;
    completedAt: string | null;
}

interface Finding {
    id: string;
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
    type: string;
    file: string;
    line?: number;
    message: string;
    suggestion?: string;
    confidence: number;
}

interface ReviewResult {
    reviewJobId: string;
    status: string;
    summary: {
        verdict: 'approve' | 'request-changes' | 'comment';
        confidence: number;
        changes: { additions: number; deletions: number; files: number };
    } | null;
    findings: Finding[];
    suggestedChanges: Array<{
        findingId: string;
        file: string;
        line?: number;
        replacement: string;
        description: string;
    }>;
    chatMessage: { role: 'system'; content: string } | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getOption(args: string[], name: string): string | undefined {
    const flag = `--${name}`;
    const index = args.indexOf(flag);
    if (index === -1) return undefined;
    return args[index + 1];
}

function hasFlag(args: string[], name: string): boolean {
    return args.includes(`--${name}`);
}

function parseFocusOption(raw: string | undefined): FocusArea {
    const allowed: FocusArea[] = ['all', 'security', 'performance', 'style', 'logic'];
    if (!raw) return 'all';
    if (allowed.includes(raw as FocusArea)) return raw as FocusArea;
    throw new Error(`--focus must be one of: ${allowed.join(', ')}`);
}

function severityColor(severity: Finding['severity']): typeof chalk {
    switch (severity) {
        case 'critical': return chalk.red.bold;
        case 'high': return chalk.redBright;
        case 'medium': return chalk.yellow;
        case 'low': return chalk.cyan;
        default: return chalk.gray;
    }
}

function printFindings(findings: Finding[]): void {
    if (findings.length === 0) {
        console.log(chalk.green('\nNo findings — looks great!\n'));
        return;
    }

    const sorted = [...findings].sort((a, b) => {
        const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
        return (order[a.severity] ?? 5) - (order[b.severity] ?? 5);
    });

    console.log(chalk.bold(`\nFindings (${sorted.length}):\n`));

    for (const finding of sorted) {
        const colorFn = severityColor(finding.severity);
        const location = finding.line
            ? `${finding.file}:${finding.line}`
            : finding.file;

        console.log(
            colorFn(`[${finding.severity.toUpperCase()}]`) +
            chalk.gray(` ${finding.type.toUpperCase()}`) +
            ` — ${location}`
        );
        console.log(`  ${finding.message}`);
        if (finding.suggestion) {
            console.log(chalk.gray(`  Suggestion: ${finding.suggestion}`));
        }
        console.log(chalk.gray(`  Confidence: ${Math.round(finding.confidence * 100)}%`));
        console.log();
    }
}

/**
 * Resolve the team ID to use for the review.
 * Prefers the --team flag; falls back to listing the user's teams and
 * picking the first one.
 */
async function resolveTeamId(
    token: string,
    explicitTeamId: string | undefined
): Promise<string> {
    if (explicitTeamId) return explicitTeamId;

    const serverUrl = configuration.serverUrl;
    const response = await fetch(`${serverUrl}/v1/artifacts`, {
        headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
        throw new Error('Failed to list teams');
    }

    const data = await response.json() as { artifacts: Array<{ id: string; type: string }> };
    const teams = (data.artifacts ?? []).filter(a => a.type === 'team');

    if (teams.length === 0) {
        throw new Error('No teams found. Create a team first with `aha teams`.');
    }

    return teams[0].id;
}

/**
 * Start a review job and return the job metadata.
 */
async function startReview(
    token: string,
    teamId: string,
    prUrl: string | undefined,
    branch: string,
    focus: FocusArea
): Promise<ReviewJob> {
    const serverUrl = configuration.serverUrl;
    const url = `${serverUrl}/v1/teams/${encodeURIComponent(teamId)}/review/start`;

    const body: Record<string, unknown> = { focus: [focus] };
    if (prUrl) {
        body.prUrl = prUrl;
    } else {
        body.branch = branch;
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `Server returned ${response.status}`);
    }

    return response.json() as Promise<ReviewJob>;
}

/**
 * Poll until the review job is complete or failed.
 * Uses exponential back-off up to 10 s between polls.
 */
async function pollUntilDone(
    token: string,
    teamId: string,
    jobId: string,
    timeoutMs = 120_000
): Promise<ReviewResult> {
    const serverUrl = configuration.serverUrl;
    const url = `${serverUrl}/v1/teams/${encodeURIComponent(teamId)}/review/${encodeURIComponent(jobId)}`;
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;

    while (Date.now() < deadline) {
        await new Promise<void>(resolve =>
            setTimeout(resolve, Math.min(1500 * Math.pow(1.3, attempt), 10_000))
        );
        attempt += 1;

        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
        });

        if (!response.ok) continue;

        const data = await response.json() as ReviewResult;
        if (data.status === 'completed' || data.status === 'failed') {
            return data;
        }

        process.stdout.write('.');
    }

    throw new Error('Review timed out after 2 minutes');
}

// ---------------------------------------------------------------------------
// Show help
// ---------------------------------------------------------------------------

export function showReviewHelp(): void {
    console.log(`
${chalk.bold.cyan('Aha Review')} - AI-powered code review via Code Review Gateway (R12)

${chalk.bold('Usage:')}
  ${chalk.green('aha review')} [options]

${chalk.bold('Options:')}
  ${chalk.cyan('--pr <url>')}              Review a specific GitHub/GitLab PR URL
  ${chalk.cyan('--focus <area>')}          Focus area: all (default), security, performance, style, logic
  ${chalk.cyan('--team <teamId>')}         Team to run the review under (defaults to first team)
  ${chalk.cyan('--timeout <seconds>')}     Max wait time in seconds (default 120)
  ${chalk.cyan('--json')}                  Output raw JSON result instead of formatted output
  ${chalk.cyan('--help, -h')}              Show this help message

${chalk.bold('Examples:')}
  ${chalk.gray('# Review current branch')}
  ${chalk.green('aha review')}

  ${chalk.gray('# Review a specific PR')}
  ${chalk.green('aha review --pr https://github.com/org/repo/pull/42')}

  ${chalk.gray('# Focus on security only')}
  ${chalk.green('aha review --focus security')}

  ${chalk.gray('# Full review for a specific team, output as JSON')}
  ${chalk.green('aha review --team team_abc123 --focus all --json')}

${chalk.bold('Exit codes:')}
  0  No critical findings
  1  Critical findings detected (or review failed)
`);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleReviewCommand(args: string[]): Promise<void> {
    if (args.length === 0 && process.argv.includes('--help')) {
        showReviewHelp();
        return;
    }

    if (
        args[0] === 'help' ||
        args[0] === '--help' ||
        args[0] === '-h'
    ) {
        showReviewHelp();
        return;
    }

    const prUrl = getOption(args, 'pr');
    const rawFocus = getOption(args, 'focus');
    const teamIdArg = getOption(args, 'team');
    const rawTimeout = getOption(args, 'timeout');
    const outputJson = hasFlag(args, 'json');

    const focus = parseFocusOption(rawFocus);
    const timeoutSeconds = rawTimeout ? Number(rawTimeout) : 120;

    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 10) {
        throw new Error('--timeout must be a number >= 10');
    }

    // Auth
    const credentials = readCredentials();
    if (!credentials) {
        console.log(chalk.yellow('Not authenticated. Run:'), chalk.green('aha auth login'));
        process.exit(1);
    }

    const { credentials: authCredentials } = await authAndSetupMachineIfNeeded();
    const token = authCredentials.token;

    try {
        // Resolve team
        console.log(chalk.cyan('Resolving team...'));
        const teamId = await resolveTeamId(token, teamIdArg);

        // Determine branch / source info for display
        const source = prUrl ? `PR: ${prUrl}` : 'current branch (HEAD)';
        console.log(chalk.cyan(`Starting review for ${source} (focus: ${focus})...`));

        // Start job
        const job = await startReview(token, teamId, prUrl, 'HEAD', focus);
        console.log(chalk.gray(`Job ID: ${job.reviewJobId} | Est. ${job.estimatedTime}s`));
        process.stdout.write(chalk.gray('Waiting for results'));

        // Poll
        const result = await pollUntilDone(
            token,
            teamId,
            job.reviewJobId,
            timeoutSeconds * 1000
        );
        console.log(); // newline after dots

        if (outputJson) {
            console.log(JSON.stringify(result, null, 2));
            const hasCritical = result.findings.some(f => f.severity === 'critical');
            process.exit(hasCritical ? 1 : 0);
        }

        // Print summary
        if (result.status === 'failed') {
            console.log(chalk.red('Review failed.'));
            process.exit(1);
        }

        const { summary } = result;
        if (summary) {
            const verdictColor =
                summary.verdict === 'approve' ? chalk.green : chalk.red;
            console.log(chalk.bold('\nReview Summary'));
            console.log(chalk.gray('─'.repeat(50)));
            console.log(
                `Verdict:    ${verdictColor(summary.verdict.toUpperCase())}`
            );
            console.log(
                `Confidence: ${Math.round(summary.confidence * 100)}%`
            );
            console.log(
                `Changes:    +${summary.changes.additions} -${summary.changes.deletions}` +
                ` (${summary.changes.files} file${summary.changes.files !== 1 ? 's' : ''})`
            );
            console.log(chalk.gray('─'.repeat(50)));
        }

        printFindings(result.findings);

        if (result.chatMessage) {
            console.log(
                chalk.gray('Chat message posted to team channel.')
            );
        }

        const hasCritical = result.findings.some(f => f.severity === 'critical');
        process.exit(hasCritical ? 1 : 0);
    } catch (error) {
        logger.debug('[ReviewCommand] Error:', error);
        console.log(
            chalk.red('Error:'),
            error instanceof Error ? error.message : 'Unknown error'
        );
        process.exit(1);
    }
}
