/**
 * CLI integration for model-switch command
 * Integrates with happy's existing CLI system (index.ts)
 */

import chalk from 'chalk';
import { getModelManager } from '@/claude/sdk/modelManager';
import { handleModelSwitch } from './model-switch';
import { readFileSync, writeFileSync } from 'node:fs';

export async function handleModelSwitchCli(args: string[]): Promise<void> {
  // Parse arguments
  const options: any = {};
  let showHelp = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-h' || arg === '--help') {
      showHelp = true;
    } else if (arg === '--seeall' || arg === '-a') {
      options.list = true;
    } else if (arg === '--to' && i + 1 < args.length) {
      options.set = args[++i];
    } else if (arg === '--add' && i + 1 < args.length) {
      options.add = args[++i];
    } else if (arg === '--del' && i + 1 < args.length) {
      options.remove = args[++i];
    } else if (arg === '--upd' && i + 1 < args.length) {
      options.update = args[++i];
    } else if (arg === '--auto' && i + 1 < args.length) {
      const pattern = args[++i];
      if (['expensive', 'cheap', 'balanced'].includes(pattern)) {
        options.auto = pattern;
      } else {
        console.error(chalk.red(`Invalid auto-switch pattern: ${pattern}`));
        console.log('Valid patterns: expensive, cheap, balanced');
        process.exit(1);
      }
    } else if (arg === '--exp' && i + 1 < args.length) {
      options.export = args[++i];
    } else if (arg === '--imp' && i + 1 < args.length) {
      options.import = args[++i];
    } else if (arg === '--format' && i + 1 < args.length) {
      const format = args[++i];
      if (['table', 'json'].includes(format)) {
        options.format = format;
      } else {
        console.error(chalk.red(`Invalid format: ${format}`));
        console.log('Valid formats: table, json');
        process.exit(1);
      }
    } else if (arg === '--cost' && i + 1 < args.length) {
      options.cost = args[++i];
      // Validate cost format
      if (!options.cost.includes(':')) {
        console.error(chalk.red('Cost must be in format "input:output" (e.g., "0.003:0.015")'));
        process.exit(1);
      }
    } else if (arg === '--tags' && i + 1 < args.length) {
      options.tags = args[++i]
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t);
    } else {
      console.error(chalk.red(`Unknown argument: ${arg}`));
      showHelp = true;
      break;
    }
  }

  if (showHelp) {
    console.log(`
${chalk.bold('happy model-switch')} - Manage model configurations

${chalk.bold('Usage:')}
  happy model-switch [command] [options]

${chalk.bold('Commands:')}
  --seeall, -a              List all model configurations
  --to <name>               Switch to specified model
  --add <name>              Add a new model configuration
  --del <name>              Remove a model configuration
  --upd <name>              Update a model configuration
  --auto <pattern>          Auto-switch based on usage pattern
  --exp <file>              Export configuration to file
  --imp <file>              Import configuration from file

${chalk.bold('Options:')}
  --format <format>         Output format: table (default), json
  --cost "input:output"     Set cost per 1K tokens (e.g., "0.003:0.015")
  --tags <tag1,tag2>        Set tags (comma-separated)
  -h, --help                Show this help

${chalk.bold('Examples:')}
  happy model-switch --seeall              List all models
  happy model-switch --to claude-3-5-haiku    Switch to model
  happy model-switch --add my-model --cost "0.003:0.015" --tags "fast,cheap"  Add model
  happy model-switch --auto cheap          Auto-switch to cheaper model
  happy model-switch --exp config.json     Export configuration
  happy model-switch --imp config.json     Import configuration
`);
    return;
  }

  // Validate conflicting options
  const commands = ['list', 'set', 'add', 'remove', 'update', 'auto', 'export', 'import'];
  const providedCommands = commands.filter((cmd) => options[cmd]);
  if (providedCommands.length === 0) {
    // No command specified, default to --list
    options.list = true;
  } else if (providedCommands.length > 1) {
    console.error(chalk.red('Error: Only one command can be specified at a time'));
    process.exit(1);
  }

  // Run command
  await handleModelSwitch(options);
}
