/**
 * Ralph CLI Command Handler
 *
 * Handles `aha ralph <subcommand>` commands:
 *   - start [--prd <path>] [--max-iterations <n>]
 *   - status [--prd <path>]
 *   - stop
 *
 * Follows the pattern from src/commands/connect.ts.
 */

import chalk from 'chalk';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runRalphLoop } from './loop';
import { loadPrd, getPrdStats } from './prdManager';
import type { RalphConfig } from './types';

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
    };

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

function showRalphHelp(): void {
    console.log(`
${chalk.bold('aha ralph')} - Ralph autonomous loop

${chalk.bold('Usage:')}
  aha ralph start [options]     Start the Ralph loop
  aha ralph status [options]    Show PRD progress
  aha ralph stop                Stop a running loop gracefully

${chalk.bold('Start Options:')}
  --prd <path>              Path to prd.json (default: ./prd.json)
  --max-iterations <n>      Maximum iterations (default: 10)
  --model <model>           Claude model to use

${chalk.bold('Status Options:')}
  --prd <path>              Path to prd.json (default: ./prd.json)

${chalk.bold('Examples:')}
  aha ralph start --prd ./tasks/prd.json
  aha ralph start --max-iterations 20
  aha ralph status
  aha ralph stop
`);
}
