/**
 * Interactive Shell for aha CLI
 *
 * Provides an interactive mode for the Ralph Loop with:
 * - Command history
 * - Auto-completion
 * - Real-time progress display
 * - Interactive task management
 */

import { createInterface } from 'readline';
import { readFileSync, appendFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import chalk from 'chalk';
import { logger } from '@/ui/logger';
import { runRalphLoop } from './loop';
import { loadPrd, getPrdStats } from './prdManager';
import type { RalphConfig } from './types';

/**
 * Interactive Shell Mode
 *
 * Provides an interactive REPL-like interface for managing the Ralph Loop.
 */
export class InteractiveShell {
    private rl: any;
    private commandHistory: string[] = [];
    private currentLoopState: any = null;
    private loopPromise: Promise<any> | null = null;
    private isRunning: boolean = false;

    constructor(private config: RalphConfig) {}

    /**
     * Start the interactive shell
     */
    async start(): Promise<void> {
        console.log(chalk.bold.cyan('\n  Interactive Ralph Shell'));
        console.log(chalk.gray('  Type "help" for available commands\n'));

        this.rl = createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: chalk.cyan('ralph> '),
            history: this.commandHistory,
            historySize: 100,
            completer: (line: string) => this.completer(line),
        });

        this.rl.on('line', async (line: string) => {
            const trimmed = line.trim();
            if (!trimmed) {
                this.rl.prompt();
                return;
            }

            // Add to history
            this.commandHistory.push(trimmed);

            // Parse command
            const [command, ...args] = trimmed.split(' ');
            const argString = args.join(' ');

            try {
                await this.handleCommand(command, argString);
            } catch (error) {
                console.error(chalk.red(`  Error: ${error instanceof Error ? error.message : String(error)}`));
            }

            this.rl.prompt();
        });

        this.rl.on('close', () => {
            console.log('\n  Goodbye!');
            if (this.isRunning) {
                this.stopLoop().catch(logger.debug);
            }
            process.exit(0);
        });

        this.rl.prompt();
    }

    /**
     * Command completer for auto-completion
     */
    private completer(line: string): any {
        const commands = [
            'start',
            'stop',
            'status',
            'list',
            'help',
            'clear',
            'quit',
            'exit',
        ];

        const completions = commands.filter(cmd => cmd.startsWith(line));
        return [completions, line];
    }

    /**
     * Handle commands
     */
    private async handleCommand(command: string, args: string): Promise<void> {
        switch (command) {
            case 'help':
            case '?':
                this.showHelp();
                break;

            case 'start':
                await this.startLoop();
                break;

            case 'stop':
                await this.stopLoop();
                break;

            case 'status':
                await this.showStatus();
                break;

            case 'list':
            case 'ls':
                await this.listTasks();
                break;

            case 'clear':
            case 'cls':
                this.clearScreen();
                break;

            case 'quit':
            case 'exit':
                console.log('\n  Goodbye!');
                process.exit(0);

            default:
                console.log(chalk.yellow(`  Unknown command: ${command}`));
                console.log(chalk.gray('  Type "help" for available commands'));
        }
    }

    /**
     * Show help message
     */
    private showHelp(): void {
        const helpText = `
${chalk.bold.cyan('Available Commands:')}

  start           Start the Ralph Loop
  stop            Stop the current loop gracefully
  status          Show current loop status
  list / ls       List all tasks from PRD
  clear / cls     Clear the screen
  help / ?        Show this help message
  quit / exit     Exit the interactive shell

${chalk.bold.cyan('Examples:')}

  ralph> start
  ralph> status
  ralph> list
  ralph> stop
`;
        console.log(helpText);
    }

    /**
     * Start the Ralph Loop
     */
    private async startLoop(): Promise<void> {
        if (this.isRunning) {
            console.log(chalk.yellow('  Loop is already running'));
            return;
        }

        console.log(chalk.green('  Starting Ralph Loop...'));
        console.log(chalk.gray('  Press Ctrl+C to interrupt\n'));

        this.isRunning = true;

        try {
            this.loopPromise = runRalphLoop(this.config);
            this.currentLoopState = await this.loopPromise;
            this.isRunning = false;
            console.log(chalk.green('\n  Loop completed'));
        } catch (error) {
            this.isRunning = false;
            console.error(chalk.red(`  Loop failed: ${error instanceof Error ? error.message : String(error)}`));
        }
    }

    /**
     * Stop the current loop
     */
    private async stopLoop(): Promise<void> {
        if (!this.isRunning) {
            console.log(chalk.yellow('  Loop is not running'));
            return;
        }

        console.log(chalk.yellow('  Stopping loop...'));

        // Write stop sentinel
        const stopSentinel = join(this.config.workingDirectory, '.ralph-stop');
        appendFileSync(stopSentinel, `stop requested at ${new Date().toISOString()}\n`);

        if (this.loopPromise) {
            try {
                await this.loopPromise;
            } catch {
                // Ignore errors from stopped loop
            }
        }

        this.isRunning = false;
        console.log(chalk.green('  Loop stopped'));
    }

    /**
     * Show loop status
     */
    private async showStatus(): Promise<void> {
        const prdPath = resolve(this.config.workingDirectory, this.config.prdPath);

        if (!existsSync(prdPath)) {
            console.log(chalk.red('  PRD not found'));
            return;
        }

        try {
            const prd = await loadPrd(prdPath);
            const stats = getPrdStats(prd);

            console.log(`
  ${chalk.bold.cyan('Project:')} ${prd.project}
  ${chalk.bold.cyan('Branch:')}  ${prd.branchName}
  ${chalk.bold.cyan('Status:')}  ${this.isRunning ? chalk.green('Running') : chalk.gray('Idle')}
  ${chalk.bold.cyan('Progress:')} ${stats.completed}/${stats.total} stories complete
`);
        } catch (error) {
            console.log(chalk.red(`  Error reading PRD: ${error instanceof Error ? error.message : String(error)}`));
        }
    }

    /**
     * List tasks from PRD
     */
    private async listTasks(): Promise<void> {
        const prdPath = resolve(this.config.workingDirectory, this.config.prdPath);

        if (!existsSync(prdPath)) {
            console.log(chalk.red('  PRD not found'));
            return;
        }

        try {
            const prd = await loadPrd(prdPath);

            console.log(chalk.bold.cyan('\n  Tasks:'));
            console.log(chalk.gray('  ──────'));

            for (const story of prd.userStories) {
                const icon = story.passes
                    ? chalk.green('✓')
                    : chalk.yellow('○');
                console.log(`  ${icon} ${story.id}: ${story.title}`);
                if (story.notes) {
                    console.log(chalk.gray(`      ${story.notes}`));
                }
            }
            console.log();
        } catch (error) {
            console.log(chalk.red(`  Error reading PRD: ${error instanceof Error ? error.message : String(error)}`));
        }
    }

    /**
     * Clear screen
     */
    private clearScreen(): void {
        console.clear();
    }
}

/**
 * Start interactive shell for Ralph Loop
 */
export async function startInteractiveShell(config: RalphConfig): Promise<void> {
    const shell = new InteractiveShell(config);
    await shell.start();
}
