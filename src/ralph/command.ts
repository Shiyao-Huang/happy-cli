/**
 * Ralph CLI Command Handler
 *
 * Handles `aha ralph <subcommand>` commands:
 *   - start [--prd <path>] [--max-iterations <n>] [--interactive]
 *   - status [--prd <path>]
 *   - stop
 *   - interactive
 *
 * Follows the pattern from src/commands/connect.ts.
 */

import chalk from 'chalk';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { runRalphLoop } from './loop';
import { loadPrd, getPrdStats } from './prdManager';
import type { RalphConfig } from './types';
import { startInteractiveShell } from './interactive';

export async function handleRalphCommand(args: string[]): Promise<void> {
    const subcommand = args[0];

    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        showRalphHelp();
        return;
    }

    switch (subcommand) {
        case 'start':
            await handleStart(args.slice(1));
            break;
        case 'status':
            await handleStatus(args.slice(1));
            break;
        case 'stop':
            handleStop(args.slice(1));
            break;
        case 'interactive':
            await handleInteractive(args.slice(1));
            break;
        case 'heartbeat':
            handleHeartbeat(args.slice(1));
            break;
        default:
            console.error(chalk.red(`Unknown ralph subcommand: ${subcommand}`));
            showRalphHelp();
            process.exit(1);
    }
}

async function handleStart(args: string[]): Promise<void> {
    let prdPath = 'prd.json';
    let maxIterations = 10;
    let model: string | undefined;
    let startedBy: string | undefined;
    let teamMode = false;
    let skipTypeCheck = false;
    let skipTests = false;
    let skipBuild = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--prd' && i + 1 < args.length) {
            prdPath = args[++i];
        } else if (arg === '--max-iterations' && i + 1 < args.length) {
            maxIterations = parseInt(args[++i], 10);
            if (isNaN(maxIterations) || maxIterations < 1) {
                console.error(chalk.red('--max-iterations must be a positive integer'));
                process.exit(1);
            }
        } else if (arg === '--model' && i + 1 < args.length) {
            model = args[++i];
        } else if (arg === '--started-by' && i + 1 < args.length) {
            startedBy = args[++i];
        } else if (arg === '--team') {
            teamMode = true;
        } else if (arg === '--skip-typecheck') {
            skipTypeCheck = true;
        } else if (arg === '--skip-tests') {
            skipTests = true;
        } else if (arg === '--skip-build') {
            skipBuild = true;
        }
    }

    const workingDirectory = process.cwd();
    const resolvedPrd = resolve(workingDirectory, prdPath);

    if (!existsSync(resolvedPrd)) {
        console.error(chalk.red(`PRD not found: ${resolvedPrd}`));
        console.log(chalk.gray('Create a prd.json file or specify the path with --prd'));
        process.exit(1);
    }

    // Derive progress.txt path from prd.json location
    const progressPath = prdPath.replace(/\.json$/, '') + '-progress.txt';

    const config: RalphConfig = {
        prdPath,
        progressPath,
        workingDirectory,
        maxIterations,
        model,
        permissionMode: 'bypassPermissions',
        teamMode,
        qualityChecks: {
            typeCheck: !skipTypeCheck,
            testRun: !skipTests,
            buildVerify: !skipBuild,
        },
    };

    if (teamMode) {
        console.log(chalk.cyan('  Team mode enabled: Master orchestrates, agents implement'));
    }

    const state = await runRalphLoop(config);

    // Exit with appropriate code
    if (state.status === 'error') {
        process.exit(1);
    }
}

async function handleStatus(args: string[]): Promise<void> {
    let prdPath = 'prd.json';

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--prd' && i + 1 < args.length) {
            prdPath = args[++i];
        }
    }

    const resolvedPrd = resolve(process.cwd(), prdPath);

    if (!existsSync(resolvedPrd)) {
        console.error(chalk.red(`PRD not found: ${resolvedPrd}`));
        process.exit(1);
    }

    try {
        const prd = await loadPrd(resolvedPrd);
        const { completed, total } = getPrdStats(prd);

        console.log(chalk.bold.cyan('\n  Ralph Status'));
        console.log(chalk.gray(`  Project: ${prd.project}`));
        console.log(chalk.gray(`  Branch:  ${prd.branchName}`));
        console.log(`  Progress: ${completed}/${total} stories complete\n`);

        for (const story of prd.userStories) {
            const icon = story.passes ? chalk.green('  [done]') : chalk.yellow('  [todo]');
            console.log(`${icon} ${story.id}: ${story.title}`);
            if (story.notes) {
                console.log(chalk.gray(`         ${story.notes}`));
            }
        }
        console.log();
    } catch (error) {
        console.error(chalk.red(`Error reading PRD: ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
    }
}

function handleStop(args: string[]): void {
    const workingDirectory = process.cwd();
    const stopSentinel = resolve(workingDirectory, '.ralph-stop');

    writeFileSync(stopSentinel, `stop requested at ${new Date().toISOString()}\n`);
    console.log(chalk.yellow('Stop signal sent. The current iteration will complete before stopping.'));
}

function handleHeartbeat(args: string[]): void {
    const workingDirectory = process.cwd();
    const statePath = join(workingDirectory, '.aha', 'master-state.json');

    const subCmd = args[0] ?? 'status';

    switch (subCmd) {
        case 'status': {
            if (!existsSync(statePath)) {
                console.log(chalk.yellow('Master state not initialized. Run heartbeat ping first.'));
                return;
            }
            const state = JSON.parse(readFileSync(statePath, 'utf-8'));
            const lastHb = new Date(state.lastHeartbeat);
            const isStale = Date.now() - lastHb.getTime() > 2 * 60 * 1000;

            console.log(chalk.bold.cyan('\n  Master Heartbeat'));
            console.log(chalk.gray(`  Status:    ${state.loopStatus}`));
            console.log(chalk.gray(`  Health:    ${state.health?.status ?? 'unknown'}`));
            console.log(chalk.gray(`  Last Ping: ${state.lastHeartbeat}`));
            console.log(isStale ? chalk.red('  STALE (no ping in >2min)') : chalk.green('  Active'));
            console.log(chalk.gray(`  Task:      ${state.currentTask ?? 'none'}`));
            console.log(chalk.gray(`  Crashes:   ${state.recovery?.crashCount ?? 0}\n`));
            break;
        }
        case 'ping': {
            const timestamp = new Date().toISOString();
            let state: Record<string, unknown>;
            if (existsSync(statePath)) {
                state = JSON.parse(readFileSync(statePath, 'utf-8'));
            } else {
                state = {
                    version: '1.0.0',
                    loopStatus: 'idle',
                    currentTask: null,
                    lastHeartbeat: timestamp,
                    iterationCount: 0,
                    sessionId: 'cli',
                    agentRole: 'master',
                    health: { status: 'healthy', lastCheck: timestamp, uptimeSeconds: 0 },
                    recovery: { lastSuccessCommit: null, crashCount: 0, lastCrashTime: null, recoveryAttempts: 0 },
                    taskQueue: { pending: [], inProgress: [], completed: [], blocked: [] },
                    metadata: { createdAt: timestamp, updatedAt: timestamp, projectName: 'Aha Ralph Loop' },
                };
            }
            state.lastHeartbeat = timestamp;
            writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
            console.log(chalk.green(`Heartbeat pinged at ${timestamp}`));
            break;
        }
        default:
            console.log(chalk.red(`Unknown heartbeat subcommand: ${subCmd}`));
            console.log(chalk.gray('Usage: aha ralph heartbeat [status|ping]'));
    }
}

async function handleInteractive(args: string[]): Promise<void> {
    let prdPath = 'prd.json';
    let maxIterations = 10;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--prd' && i + 1 < args.length) {
            prdPath = args[++i];
        } else if (arg === '--max-iterations' && i + 1 < args.length) {
            maxIterations = parseInt(args[++i], 10);
            if (isNaN(maxIterations) || maxIterations < 1) {
                console.error(chalk.red('--max-iterations must be a positive integer'));
                process.exit(1);
            }
        }
    }

    const workingDirectory = process.cwd();
    const resolvedPrd = resolve(workingDirectory, prdPath);

    if (!existsSync(resolvedPrd)) {
        console.error(chalk.red(`PRD not found: ${resolvedPrd}`));
        console.log(chalk.gray('Create a prd.json file or specify the path with --prd'));
        process.exit(1);
    }

    const progressPath = prdPath.replace(/\.json$/, '') + '-progress.txt';

    const config: RalphConfig = {
        prdPath,
        progressPath,
        workingDirectory,
        maxIterations,
        permissionMode: 'bypassPermissions',
        qualityChecks: {
            typeCheck: true,
            testRun: true,
            buildVerify: true,
        },
    };

    console.log(chalk.cyan('\n  Interactive Ralph Shell'));
    console.log(chalk.gray(`  PRD: ${resolvedPrd}\n`));

    await startInteractiveShell(config);
}

function showRalphHelp(): void {
    console.log(`
${chalk.bold('aha ralph')} - Ralph autonomous loop

${chalk.bold('Usage:')}
  aha ralph start [options]        Start the Ralph loop
  aha ralph status [options]       Show PRD progress
  aha ralph stop                   Stop a running loop gracefully
  aha ralph interactive [options]  Start interactive shell mode
  aha ralph heartbeat [status|ping] Master heartbeat management

${chalk.bold('Start Options:')}
  --prd <path>              Path to prd.json (default: ./prd.json)
  --max-iterations <n>      Maximum iterations (default: 10)
  --model <model>           Claude model to use
  --team                    Enable team mode (multi-agent orchestration)
  --skip-typecheck          Skip TypeScript type checking in quality gate
  --skip-tests              Skip test suite in quality gate
  --skip-build              Skip build verification in quality gate

${chalk.bold('Interactive Options:')}
  --prd <path>              Path to prd.json (default: ./prd.json)
  --max-iterations <n>      Maximum iterations (default: 10)

${chalk.bold('Status Options:')}
  --prd <path>              Path to prd.json (default: ./prd.json)

${chalk.bold('Heartbeat:')}
  aha ralph heartbeat status    Show Master heartbeat state
  aha ralph heartbeat ping      Send a heartbeat ping

${chalk.bold('Examples:')}
  aha ralph start --prd ./tasks/prd.json
  aha ralph start --max-iterations 20 --team
  aha ralph start --skip-typecheck --skip-tests
  aha ralph status
  aha ralph interactive
  aha ralph heartbeat status
  aha ralph stop
`);
}
