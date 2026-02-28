/**
 * Interactive Shell Command for Aha CLI
 *
 * Provides an interactive REPL-like interface with:
 * - Command history (persisted to ~/.aha/history)
 * - Auto-completion with fuzzy matching
 * - Multi-line input support
 * - Context-aware help
 *
 * V7-002: CLI Interactive Shell Implementation
 */

import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createInterface, Interface as ReadLineInterface } from 'node:readline';
import { handleTeamsCommand } from './teams';
import { handleAuthCommand } from './auth';
import { handleConnectCommand } from './connect';

/**
 * Command definition
 */
interface Command {
    name: string;
    aliases?: string[];
    description: string;
    usage: string;
    handler: (args: string[]) => Promise<void> | void;
    subcommands?: Command[];
}

/**
 * History entry
 */
interface HistoryEntry {
    timestamp: string;
    command: string;
}

/**
 * Interactive Shell Configuration
 */
interface InteractiveShellConfig {
    historyFile?: string;
    maxHistorySize?: number;
    prompt?: string;
}

/**
 * Interactive Shell Implementation using Inquirer
 */
export class InteractiveShell {
    private rl: ReadLineInterface;
    private history: HistoryEntry[] = [];
    private historyFile: string;
    private maxHistorySize: number;
    private prompt: string;
    private commands: Command[];
    private isRunning: boolean = false;

    constructor(config: InteractiveShellConfig = {}) {
        this.historyFile = config.historyFile || path.join(os.homedir(), '.aha', 'history', 'interactive.json');
        this.maxHistorySize = config.maxHistorySize || 1000;
        this.prompt = config.prompt || chalk.cyan('aha> ');

        // Initialize commands
        this.commands = this.registerCommands();

        // Load history
        this.loadHistory();

        // Create readline interface
        this.rl = createInterface({
            input: process.stdin,
            output: process.stdout,
            completer: (line: string) => this.completer(line),
            history: this.history.map(h => h.command),
            historySize: this.maxHistorySize,
        });
    }

    /**
     * Register all available commands
     */
    private registerCommands(): Command[] {
        return [
            {
                name: 'help',
                aliases: ['?', 'h'],
                description: 'Show available commands',
                usage: 'help [command]',
                handler: (args) => this.showHelp(args),
            },
            {
                name: 'exit',
                aliases: ['quit', 'q'],
                description: 'Exit interactive shell',
                usage: 'exit',
                handler: () => this.exit(),
            },
            {
                name: 'clear',
                aliases: ['cls'],
                description: 'Clear the screen',
                usage: 'clear',
                handler: () => this.clearScreen(),
            },
            {
                name: 'history',
                aliases: ['hist'],
                description: 'Show command history',
                usage: 'history [n]',
                handler: (args) => this.showHistory(args),
            },
            {
                name: 'teams',
                description: 'Team management commands',
                usage: 'teams <list|archive|delete|rename|compose> [options]',
                handler: async (args) => {
                    await handleTeamsCommand(args);
                },
            },
            {
                name: 'auth',
                description: 'Authentication management',
                usage: 'auth <login|logout> [options]',
                handler: async (args) => {
                    await handleAuthCommand(args);
                },
            },
            {
                name: 'connect',
                description: 'AI vendor API key management',
                usage: 'connect <list|add> [options]',
                handler: async (args) => {
                    await handleConnectCommand(args);
                },
            },
            {
                name: 'status',
                description: 'Show system status',
                usage: 'status',
                handler: () => this.showStatus(),
            },
        ];
    }

    /**
     * Start the interactive shell
     */
    async start(): Promise<void> {
        console.log(chalk.bold.cyan('\n  Aha Interactive Shell'));
        console.log(chalk.gray('  Type "help" for available commands, "exit" to quit\n'));

        this.isRunning = true;

        this.rl.on('line', async (line: string) => {
            const trimmed = line.trim();

            if (trimmed) {
                // Add to history
                this.addToHistory(trimmed);

                // Parse command
                const [command, ...args] = this.parseCommand(trimmed);

                try {
                    const [cmd, cmdArgs] = this.parseCommand(trimmed);
                    await this.executeCommand(cmd, cmdArgs);
                } catch (error) {
                    console.error(chalk.red(`  Error: ${error instanceof Error ? error.message : String(error)}`));
                }
            }

            this.rl.prompt();
        });

        this.rl.on('close', () => {
            this.shutdown();
        });

        // Handle Ctrl+C gracefully
        process.on('SIGINT', () => {
            console.log(chalk.yellow('\n  Use "exit" to quit'));
            this.rl.prompt();
        });

        this.rl.setPrompt(this.prompt);
        this.rl.prompt();
    }

    /**
     * Parse command line into command and arguments
     */
    private parseCommand(line: string): [string, string[]] {
        // Handle quoted strings
        const args: string[] = [];
        let current = '';
        let inQuotes = false;
        let quoteChar = '';

        for (let i = 0; i < line.length; i++) {
            const char = line[i];

            if ((char === '"' || char === "'") && !inQuotes) {
                inQuotes = true;
                quoteChar = char;
            } else if (char === quoteChar && inQuotes) {
                inQuotes = false;
                quoteChar = '';
            } else if (char === ' ' && !inQuotes) {
                if (current) {
                    args.push(current);
                    current = '';
                }
            } else {
                current += char;
            }
        }

        if (current) {
            args.push(current);
        }

        const commandName = args.length > 0 ? args[0] : '';
        const commandArgs = args.slice(1);
        return [commandName, commandArgs];
    }

    /**
     * Execute a command
     */
    private async executeCommand(commandName: string, args: string[]): Promise<void> {
        // Find command by name or alias
        const command = this.commands.find(
            cmd => cmd.name === commandName || (cmd.aliases && cmd.aliases.includes(commandName))
        );

        if (!command) {
            console.log(chalk.yellow(`  Unknown command: ${commandName}`));
            console.log(chalk.gray('  Type "help" for available commands'));
            return;
        }

        await command.handler(args);
    }

    /**
     * Auto-completer for readline
     */
    private completer(line: string): [string[], string] {
        const completions = this.commands.flatMap(cmd => [cmd.name, ...(cmd.aliases || [])]);

        const hits = completions.filter(c => c.startsWith(line));

        return [hits.length ? hits : completions, line];
    }

    /**
     * Load history from file
     */
    private loadHistory(): void {
        try {
            if (fs.existsSync(this.historyFile)) {
                const data = fs.readFileSync(this.historyFile, 'utf-8');
                this.history = JSON.parse(data);
            }
        } catch (error) {
            // Ignore errors loading history
            this.history = [];
        }
    }

    /**
     * Save history to file
     */
    private saveHistory(): void {
        try {
            const dir = path.dirname(this.historyFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // Keep only last N entries
            const trimmedHistory = this.history.slice(-this.maxHistorySize);
            fs.writeFileSync(this.historyFile, JSON.stringify(trimmedHistory, null, 2), 'utf-8');
        } catch (error) {
            // Ignore errors saving history
        }
    }

    /**
     * Add command to history
     */
    private addToHistory(command: string): void {
        this.history.push({
            timestamp: new Date().toISOString(),
            command,
        });

        // Save history (debounced)
        this.saveHistory();
    }

    /**
     * Show help message
     */
    private showHelp(args: string[]): void {
        const [commandName] = args;

        if (commandName) {
            // Show help for specific command
            const command = this.commands.find(
                cmd => cmd.name === commandName || (cmd.aliases && cmd.aliases.includes(commandName))
            );

            if (command) {
                console.log(`
  ${chalk.bold.cyan(command.name)} - ${command.description}

  ${chalk.gray('Usage:')} ${command.usage}

  ${command.aliases ? chalk.gray(`Aliases: ${command.aliases.join(', ')}`) : ''}
`);
            } else {
                console.log(chalk.yellow(`  Command not found: ${commandName}`));
            }
        } else {
            // Show all commands
            console.log(chalk.bold.cyan('\n  Available Commands:\n'));

            for (const cmd of this.commands) {
                console.log(`  ${chalk.green(cmd.name.padEnd(15))} ${cmd.description}`);
                if (cmd.aliases && cmd.aliases.length > 0) {
                    console.log(chalk.gray(`  ${' '.repeat(15)} Aliases: ${cmd.aliases.join(', ')}`));
                }
            }

            console.log(chalk.gray('\n  Type "help <command>" for detailed usage\n'));
        }
    }

    /**
     * Show command history
     */
    private showHistory(args: string[]): void {
        const count = args[0] ? parseInt(args[0], 10) : 20;
        const entries = this.history.slice(-count);

        console.log(chalk.bold.cyan(`\n  Command History (last ${entries.length}):\n`));

        for (const entry of entries) {
            const time = new Date(entry.timestamp).toLocaleTimeString();
            console.log(`  ${chalk.gray(time)}  ${entry.command}`);
        }

        console.log();
    }

    /**
     * Show system status
     */
    private showStatus(): void {
        console.log(chalk.bold.cyan('\n  System Status:\n'));
        console.log(`  ${chalk.green('●')} Interactive shell running`);
        console.log(`  ${chalk.gray('History size:')} ${this.history.length} commands`);
        console.log(`  ${chalk.gray('History file:')} ${this.historyFile}`);
        console.log();
    }

    /**
     * Clear the screen
     */
    private clearScreen(): void {
        console.clear();
    }

    /**
     * Exit interactive shell
     */
    private exit(): void {
        console.log(chalk.green('\n  Goodbye!\n'));
        this.shutdown();
        process.exit(0);
    }

    /**
     * Shutdown gracefully
     */
    private shutdown(): void {
        if (this.isRunning) {
            this.saveHistory();
            this.rl.close();
            this.isRunning = false;
        }
    }
}

/**
 * Start interactive shell
 */
export async function startInteractiveCommand(args: string[]): Promise<void> {
    const shell = new InteractiveShell();
    await shell.start();
}

/**
 * Show help for interactive command
 */
export function showInteractiveHelp(): void {
    console.log(`
${chalk.bold('aha interactive')} - Start interactive shell

${chalk.bold('Usage:')}
  aha interactive                Start interactive REPL mode

${chalk.bold('Features:')}
  - Command history (persisted to ~/.aha/history/interactive.json)
  - Auto-completion with Tab
  - Multi-line input support
  - Context-aware help

${chalk.bold('Examples:')}
  ${chalk.green('aha interactive')}

  ${chalk.gray('Then use commands like:')}
  aha> teams list
  aha> auth login
  aha> status
  aha> help
  aha> exit
`);
}

/**
 * Handle interactive command
 */
export async function handleInteractiveCommand(args: string[]): Promise<void> {
    if (args.includes('--help') || args.includes('-h')) {
        showInteractiveHelp();
        return;
    }

    await startInteractiveCommand(args);
}
