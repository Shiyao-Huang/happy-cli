import chalk from 'chalk';

export class CliCommandError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly hint?: string;

  constructor(message: string, options?: { code?: string; exitCode?: number; hint?: string }) {
    super(message);
    this.name = 'CliCommandError';
    this.code = options?.code ?? 'CLI_ERROR';
    this.exitCode = options?.exitCode ?? 1;
    this.hint = options?.hint;
  }
}

export function normalizeGlobalCliArgs(rawArgs: string[]): string[] {
  const normalized: string[] = [];
  let format: 'json' | 'table' | null = null;
  let sawJson = false;

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (arg === '--json') {
      sawJson = true;
      normalized.push(arg);
      continue;
    }

    if (arg === '--no-interactive') {
      process.env.AHA_NO_INTERACTIVE = '1';
      continue;
    }

    if (arg === '--format') {
      const value = rawArgs[index + 1];
      if (!value) {
        throw new CliCommandError('Missing value for --format.', {
          code: 'INVALID_ARGUMENT',
          exitCode: 2,
          hint: 'Use --format json or --format table.',
        });
      }
      if (value !== 'json' && value !== 'table') {
        throw new CliCommandError(`Unsupported --format value: ${value}`, {
          code: 'INVALID_ARGUMENT',
          exitCode: 2,
          hint: 'Allowed values are: json, table.',
        });
      }
      format = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('--format=')) {
      const value = arg.slice('--format='.length);
      if (value !== 'json' && value !== 'table') {
        throw new CliCommandError(`Unsupported --format value: ${value}`, {
          code: 'INVALID_ARGUMENT',
          exitCode: 2,
          hint: 'Allowed values are: json, table.',
        });
      }
      format = value;
      continue;
    }

    normalized.push(arg);
  }

  if (format === 'table' && sawJson) {
    throw new CliCommandError('Cannot combine --json with --format table.', {
      code: 'INVALID_ARGUMENT',
      exitCode: 2,
      hint: 'Use either --json or --format table.',
    });
  }

  if (format === 'json' && !sawJson) {
    normalized.push('--json');
  }

  return normalized;
}

export function isNonInteractiveMode(): boolean {
  return process.env.AHA_NO_INTERACTIVE === '1';
}

export type CliDryRunPreview = {
  action: string;
  summary: string;
  target?: unknown;
  payload?: unknown;
};

export function printCliDryRunPreview(
  preview: CliDryRunPreview,
  options?: {
    asJson?: boolean;
  },
): void {
  const document = {
    dryRun: true,
    ...preview,
  };

  if (options?.asJson) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    return;
  }

  console.log(chalk.cyan('Dry run:'), preview.summary);

  if (preview.target !== undefined) {
    console.log(chalk.gray('  target:'), JSON.stringify(preview.target));
  }

  if (preview.payload !== undefined) {
    console.log(chalk.gray('  payload:'), JSON.stringify(preview.payload));
  }
}

export async function confirmPrompt(
  prompt: string,
  options?: {
    force?: boolean;
    forceFlagName?: string;
  },
): Promise<boolean> {
  if (options?.force) {
    return true;
  }

  if (isNonInteractiveMode()) {
    const forceFlagName = options?.forceFlagName ?? '--yes';
    throw new CliCommandError('Interactive confirmation disabled by --no-interactive.', {
      code: 'INTERACTIVE_REQUIRED',
      exitCode: 2,
      hint: `Re-run with ${forceFlagName} to confirm without a prompt.`,
    });
  }

  const { default: readline } = await import('node:readline/promises');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(chalk.cyan(prompt));
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

export function printCliCommandError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.red('Error:'), message);

  if (error instanceof CliCommandError && error.hint) {
    console.error(chalk.gray('Hint:'), error.hint);
  } else if (process.env.DEBUG) {
    console.error(error);
  }
}

export function getCliCommandExitCode(error: unknown): number {
  return error instanceof CliCommandError ? error.exitCode : 1;
}
