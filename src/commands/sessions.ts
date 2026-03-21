import chalk from 'chalk';

import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { readCredentials } from '@/persistence';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { resolveContextWindowTokens } from '@/utils/modelContextWindows';

function getOption(args: string[], name: string): string | undefined {
  const flag = `--${name}`;
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return flags.some(flag => args.includes(flag));
}

function getPositionalArgs(args: string[]): string[] {
  const positional: string[] = [];
  const booleanFlags = new Set(['--json', '--force', '-f', '--verbose', '-v', '--active', '--help', '-h']);

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith('-')) {
      if (!booleanFlags.has(value) && index + 1 < args.length && !args[index + 1].startsWith('-')) {
        index += 1;
      }
      continue;
    }
    positional.push(value);
  }

  return positional;
}

async function confirm(prompt: string): Promise<boolean> {
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

async function createApiClient(): Promise<ApiClient> {
  const credentials = await readCredentials();
  if (!credentials) {
    console.log(chalk.yellow('Not authenticated. Please run:'), chalk.green('aha auth login'));
    process.exit(1);
  }

  const { credentials: authCredentials } = await authAndSetupMachineIfNeeded();
  return ApiClient.create(authCredentials);
}

function sanitizeSession(session: any): any {
  const { encryptionKey, encryptionVariant, ...rest } = session;
  return rest;
}

export function resolveSessionTeamId(metadata?: { teamId?: string; roomId?: string }): string | undefined {
  return metadata?.teamId || metadata?.roomId;
}

function getSessionDisplayName(session: any): string {
  const metadata = session.metadata || {};
  return metadata.name || metadata.sessionTag || metadata.claudeSessionId || session.id;
}

function printSession(session: any, verbose = false, includeModelDetails = false): void {
  const metadata = session.metadata || {};
  const role = metadata.role || 'agent';
  const teamId = resolveSessionTeamId(metadata) || '-';
  const path = metadata.path || '-';
  const state = session.active ? chalk.green('active') : chalk.gray('archived');
  const resolvedModel = metadata.resolvedModel;
  const contextWindowTokens = typeof metadata.contextWindowTokens === 'number'
    ? metadata.contextWindowTokens
    : resolveContextWindowTokens(resolvedModel);

  console.log(`${chalk.bold(session.id)} ${state} ${chalk.cyan(`[${role}]`)} ${chalk.white(getSessionDisplayName(session))}`);
  console.log(chalk.gray(`  team=${teamId} messages=${session.persistedMessageCount ?? 0} path=${path}`));

  if (!session.isDecrypted) {
    console.log(chalk.yellow('  metadata unavailable (could not decrypt session payload)'));
    return;
  }

  if (verbose) {
    if (metadata.host) {
      console.log(chalk.gray(`  host=${metadata.host}`));
    }
    if (metadata.startedBy) {
      console.log(chalk.gray(`  startedBy=${metadata.startedBy}`));
    }
    if (metadata.sessionTag) {
      console.log(chalk.gray(`  sessionTag=${metadata.sessionTag}`));
    }
    if (metadata.summary?.text) {
      console.log(chalk.gray(`  summary=${metadata.summary.text}`));
    }
  }

  if (includeModelDetails) {
    if (resolvedModel) {
      console.log(chalk.gray(`  resolvedModel=${resolvedModel}`));
    }
    if (typeof contextWindowTokens === 'number') {
      console.log(chalk.gray(`  contextWindowTokens=${contextWindowTokens}`));
    }
  }
}

export function showSessionsHelp(): void {
  console.log(`
${chalk.bold.cyan('Aha Sessions')} - Direct session management commands

${chalk.bold('Usage:')}
  ${chalk.green('aha sessions')} <command> [options]

${chalk.bold('Commands:')}
  ${chalk.yellow('list')}                          List sessions
  ${chalk.yellow('show')} <sessionId>              Show one session
  ${chalk.yellow('archive')} <sessionId>           Archive one session
  ${chalk.yellow('unarchive')} <sessionId>         Restore one archived session
  ${chalk.yellow('delete')} <sessionId>            Delete one session

${chalk.bold('List options:')}
  ${chalk.cyan('--active')}                       Only show active sessions
  ${chalk.cyan('--team <teamId>')}                Filter by metadata.teamId
  ${chalk.cyan('--json')}                         Print raw JSON output
  ${chalk.cyan('--verbose, -v')}                  Show extra metadata fields

${chalk.bold('Workflow options:')}
  ${chalk.cyan('--force, -f')}                    Skip archive/delete confirmation

${chalk.bold('Examples:')}
  ${chalk.green('aha sessions list --active')}
  ${chalk.green('aha sessions list --team team_123')}
  ${chalk.green('aha sessions show session_123')}
  ${chalk.green('aha sessions archive session_123 --force')}
  ${chalk.green('aha sessions delete session_123 --force')}
`);
}

export async function handleSessionsCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h' || hasFlag(args, '--help', '-h')) {
    showSessionsHelp();
    return;
  }

  const api = await createApiClient();
  const positional = getPositionalArgs(args);
  const asJson = hasFlag(args, '--json');
  const verbose = hasFlag(args, '--verbose', '-v');

  try {
    switch (subcommand) {
      case 'list':
        await listSessions(api, {
          asJson,
          verbose,
          activeOnly: hasFlag(args, '--active'),
          teamId: getOption(args, 'team'),
        });
        break;
      case 'show':
        if (positional.length < 2) {
          throw new Error('Usage: aha sessions show <sessionId>');
        }
        await showSession(api, positional[1], asJson, verbose);
        break;
      case 'archive':
        if (positional.length < 2) {
          throw new Error('Usage: aha sessions archive <sessionId> [--force]');
        }
        await archiveSession(api, positional[1], hasFlag(args, '--force', '-f'), asJson);
        break;
      case 'unarchive':
        if (positional.length < 2) {
          throw new Error('Usage: aha sessions unarchive <sessionId> [--force]');
        }
        await unarchiveSession(api, positional[1], hasFlag(args, '--force', '-f'), asJson);
        break;
      case 'delete':
        if (positional.length < 2) {
          throw new Error('Usage: aha sessions delete <sessionId> [--force]');
        }
        await deleteSession(api, positional[1], hasFlag(args, '--force', '-f'), asJson);
        break;
      default:
        throw new Error(`Unknown sessions command: ${subcommand}`);
    }
  } catch (error) {
    logger.debug('[SessionsCommand] Error:', error);
    console.log(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}

async function listSessions(
  api: ApiClient,
  opts: { asJson: boolean; verbose: boolean; activeOnly: boolean; teamId?: string },
): Promise<void> {
  const result = await api.listSessions();
  const filteredSessions = result.sessions.filter((session: any) => {
    const metadata = session.metadata || {};
    if (opts.activeOnly && !session.active) {
      return false;
    }
    if (opts.teamId && resolveSessionTeamId(metadata) !== opts.teamId) {
      return false;
    }
    return true;
  });

  if (opts.asJson) {
    console.log(JSON.stringify({ sessions: filteredSessions.map(sanitizeSession) }, null, 2));
    return;
  }

  if (!filteredSessions.length) {
    console.log(chalk.yellow('No sessions found.'));
    return;
  }

  console.log(chalk.bold(`\nSessions (${filteredSessions.length})\n`));
  for (const session of filteredSessions) {
    printSession(session, opts.verbose);
  }
  console.log();
}

async function showSession(api: ApiClient, sessionId: string, asJson: boolean, verbose: boolean): Promise<void> {
  const session = await api.getSession(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  if (asJson) {
    console.log(JSON.stringify(sanitizeSession(session), null, 2));
    return;
  }

  console.log(chalk.bold(`\nSession ${sessionId}\n`));
  printSession(session, verbose, true);
  console.log();
}

async function archiveSession(api: ApiClient, sessionId: string, force: boolean, asJson: boolean): Promise<void> {
  if (!force) {
    const confirmed = await confirm(`Archive session ${sessionId}? (y/N): `);
    if (!confirmed) {
      console.log(chalk.yellow('Operation cancelled'));
      return;
    }
  }

  const result = await api.batchArchiveSessions([sessionId]);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const entry = Array.isArray(result.results) ? result.results[0] : null;
  if (entry?.success === false) {
    throw new Error(entry.error || `Failed to archive session ${sessionId}`);
  }

  console.log(chalk.green(`✓ Archived session ${sessionId}`));
  console.log();
}

async function unarchiveSession(api: ApiClient, sessionId: string, force: boolean, asJson: boolean): Promise<void> {
  if (!force) {
    const confirmed = await confirm(`Restore archived session ${sessionId}? (y/N): `);
    if (!confirmed) {
      console.log(chalk.yellow('Operation cancelled'));
      return;
    }
  }

  const result = await api.batchUnarchiveSessions([sessionId]);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const entry = Array.isArray(result.results) ? result.results[0] : null;
  if (entry?.success === false) {
    throw new Error(entry.error || `Failed to restore session ${sessionId}`);
  }

  console.log(chalk.green(`✓ Restored session ${sessionId}`));
  console.log();
}

async function deleteSession(api: ApiClient, sessionId: string, force: boolean, asJson: boolean): Promise<void> {
  if (!force) {
    const confirmed = await confirm(`Delete session ${sessionId}? This cannot be undone. (y/N): `);
    if (!confirmed) {
      console.log(chalk.yellow('Operation cancelled'));
      return;
    }
  }

  const result = await api.deleteSession(sessionId);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.green(`✓ Deleted session ${sessionId}`));
  console.log();
}
