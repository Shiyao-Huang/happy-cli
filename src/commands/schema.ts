import chalk from 'chalk';
import { buildCliSchemaDocument } from './schemaRegistry';
import { CliCommandError } from './globalCli';

function showSchemaHelp(): void {
  console.log(`
${chalk.bold('aha schema')} - Machine-readable CLI command tree

${chalk.bold('Usage:')}
  aha schema --all
  aha schema [command] [subcommand]
  aha schema help

${chalk.bold('Examples:')}
  aha schema --all
  aha schema teams
  aha schema teams status

${chalk.bold('Notes:')}
  • Output is always JSON
  • Use this command to let agents discover commands, aliases, usage, and global flags
`);
}

export async function handleSchemaCommand(args: string[]): Promise<void> {
  if (args.length === 0 || args.includes('--all')) {
    process.stdout.write(`${JSON.stringify(buildCliSchemaDocument([]), null, 2)}\n`);
    return;
  }

  if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    showSchemaHelp();
    return;
  }

  const pathTokens = args.filter((arg) => !arg.startsWith('-'));
  const document = buildCliSchemaDocument(pathTokens);
  if (document.found !== true) {
    throw new CliCommandError(`Unknown schema path: ${pathTokens.join(' ')}`, {
      code: 'NOT_FOUND',
      exitCode: 3,
      hint: 'Run "aha schema --all" to inspect the full command tree.',
    });
  }

  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
}
