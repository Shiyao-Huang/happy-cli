import chalk from 'chalk';
import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { readCredentials } from '@/persistence';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { confirmPrompt, getCliCommandExitCode, printCliCommandError, printCliDryRunPreview } from './globalCli';
import { t } from '@/i18n';

const TASK_STATUSES = ['todo', 'in-progress', 'review', 'blocked', 'done'] as const;
const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
const HUMAN_LOCK_MODES = ['viewing', 'editing', 'manual-status'] as const;

type TaskStatus = (typeof TASK_STATUSES)[number];
type TaskPriority = (typeof TASK_PRIORITIES)[number];
type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

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
  const booleanFlags = new Set(['--json', '--force', '-f', '--verbose', '-v', '--help', '-h', '--dry-run']);

  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (value.startsWith('-')) {
      if (!booleanFlags.has(value) && i + 1 < args.length && !args[i + 1].startsWith('-')) {
        i += 1;
      }
      continue;
    }
    positional.push(value);
  }

  return positional;
}

function parseEnumOption<T extends readonly string[]>(
  args: string[],
  name: string,
  allowed: T,
): T[number] | undefined {
  const value = getOption(args, name);
  if (value === undefined) {
    return undefined;
  }
  if ((allowed as readonly string[]).includes(value)) {
    return value as T[number];
  }
  throw new Error(`--${name} must be one of: ${allowed.join(', ')}`);
}

function parseLabelsOption(args: string[]): string[] | undefined {
  const raw = getOption(args, 'labels');
  if (!raw) {
    return undefined;
  }
  const labels = raw
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return labels.length > 0 ? labels : undefined;
}

function resolveTeamId(args: string[]): string {
  const teamId = getOption(args, 'team') || process.env.AHA_ROOM_ID;
  if (!teamId) {
    throw new Error('Team ID is required. Pass --team <teamId> or run inside a team session with AHA_ROOM_ID set.');
  }
  return teamId;
}

function resolveSessionId(args: string[]): string {
  return getOption(args, 'session') || process.env.AHA_SESSION_ID || 'cli';
}

function colorizeStatus(status: string | undefined): string {
  switch (status) {
    case 'done':
      return chalk.green(status);
    case 'blocked':
      return chalk.red(status);
    case 'review':
      return chalk.magenta(status);
    case 'in-progress':
      return chalk.yellow(status);
    default:
      return chalk.gray(status || 'todo');
  }
}

function printTask(task: any, verbose = false): void {
  const priority = task.priority || 'medium';
  const assignee = task.assigneeId || 'unassigned';
  const taskId = task.id || 'unknown';
  const title = task.title || '(untitled)';

  console.log(
    `${chalk.bold(taskId)} ${colorizeStatus(task.status)} ${chalk.cyan(`[${priority}]`)} ${chalk.white(title)}`
  );
  console.log(chalk.gray(`  assignee=${assignee}`));

  if (task.description) {
    console.log(chalk.gray(`  ${task.description}`));
  }

  if (task.humanStatusLock) {
    const lock = task.humanStatusLock;
    const lockedBy = lock.lockedByDisplayName || lock.lockedBySessionId || 'human';
    console.log(chalk.yellow(`  human-lock=${lock.mode} by=${lockedBy}`));
  }

  if (verbose) {
    if (Array.isArray(task.labels) && task.labels.length > 0) {
      console.log(chalk.gray(`  labels=${task.labels.join(', ')}`));
    }
    if (task.parentTaskId) {
      console.log(chalk.gray(`  parent=${task.parentTaskId}`));
    }
    if (task.approvalStatus) {
      console.log(chalk.gray(`  approval=${task.approvalStatus}`));
    }
    if (Array.isArray(task.subtaskIds) && task.subtaskIds.length > 0) {
      console.log(chalk.gray(`  subtasks=${task.subtaskIds.length}`));
    }
  }
}

async function confirm(prompt: string): Promise<boolean> {
  return confirmPrompt(prompt, { forceFlagName: '--force' });
}

async function createApiClient(): Promise<ApiClient> {
  const credentials = await readCredentials();
  if (!credentials) {
    console.log(chalk.yellow(t('common.notAuthenticated')), chalk.green('aha auth login'));
    process.exit(1);
  }

  const { credentials: authCredentials } = await authAndSetupMachineIfNeeded();
  return ApiClient.create(authCredentials);
}

function buildTaskPayload(args: string[], allowPartial: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const title = getOption(args, 'title');
  const description = getOption(args, 'description');
  const assigneeId = getOption(args, 'assignee');
  const reporterId = getOption(args, 'reporter');
  const parentTaskId = getOption(args, 'parent');
  const labels = parseLabelsOption(args);
  const status = parseEnumOption(args, 'status', TASK_STATUSES);
  const priority = parseEnumOption(args, 'priority', TASK_PRIORITIES);
  const approvalStatus = parseEnumOption(args, 'approval-status', APPROVAL_STATUSES);

  if (!allowPartial && !title) {
    throw new Error('Creating a task requires --title "<task title>"');
  }

  if (title !== undefined) payload.title = title;
  if (description !== undefined) payload.description = description;
  if (status !== undefined) payload.status = status;
  if (priority !== undefined) payload.priority = priority;
  if (assigneeId !== undefined) payload.assigneeId = assigneeId;
  if (reporterId !== undefined) payload.reporterId = reporterId;
  if (parentTaskId !== undefined) payload.parentTaskId = parentTaskId;
  if (labels !== undefined) payload.labels = labels;
  if (approvalStatus !== undefined) payload.approvalStatus = approvalStatus;

  if (allowPartial && Object.keys(payload).length === 0) {
    throw new Error('No updates provided. Pass at least one of --title, --description, --status, --priority, --assignee, --labels, --approval-status.');
  }

  return payload;
}

export function showTasksHelp(): void {
  console.log(`
${chalk.bold.cyan('Aha Tasks')} - Team task management commands

${chalk.bold('Usage:')}
  ${chalk.green('aha tasks')} <command> --team <teamId> [options]
  ${chalk.green('aha task')} <command> --team <teamId> [options]

${chalk.bold('Commands:')}
  ${chalk.yellow('list')}                          List tasks for a team
  ${chalk.yellow('show')} <taskId>                 Show a single task
  ${chalk.yellow('create')}                        Create a task
  ${chalk.yellow('update')} <taskId>               Update an existing task
  ${chalk.yellow('delete')} <taskId>               Delete a task
  ${chalk.yellow('start')} <taskId>                Mark a task in progress
  ${chalk.yellow('complete')} <taskId>             Mark a task done
  ${chalk.yellow('done')} <taskId>                 Alias for complete
  ${chalk.yellow('lock')} <taskId>                 Set a human status lock on a task
  ${chalk.yellow('unlock')} <taskId>               Clear a human status lock from a task

${chalk.bold('Common options:')}
  ${chalk.cyan('--team <teamId>')}                Team artifact ID (falls back to AHA_ROOM_ID)
  ${chalk.cyan('--json')}                         Print raw JSON response
  ${chalk.cyan('--format <json|table>')}         Select JSON or human output mode

${chalk.bold('Create / update options:')}
  ${chalk.cyan('--title "<text>"')}               Task title
  ${chalk.cyan('--description "<text>"')}         Task description
  ${chalk.cyan('--status <status>')}              ${TASK_STATUSES.join(' | ')}
  ${chalk.cyan('--priority <priority>')}          ${TASK_PRIORITIES.join(' | ')}
  ${chalk.cyan('--assignee <sessionId>')}         Assignee session ID
  ${chalk.cyan('--reporter <sessionId>')}         Reporter session ID (create only)
  ${chalk.cyan('--parent <taskId>')}              Parent task ID
  ${chalk.cyan('--labels a,b,c')}                 Comma-separated labels
  ${chalk.cyan('--approval-status <status>')}     ${APPROVAL_STATUSES.join(' | ')}

${chalk.bold('Workflow options:')}
  ${chalk.cyan('--session <sessionId>')}          Session ID for start/complete/lock (default: cli)
  ${chalk.cyan('--role <role>')}                  Role for start/update/lock (default: builder for start, user otherwise)
  ${chalk.cyan('--name <displayName>')}           Display name for update/lock attribution
  ${chalk.cyan('--mode <mode>')}                  Lock mode: viewing | editing | manual-status
  ${chalk.cyan('--reason <text>')}                Optional human-lock reason
  ${chalk.cyan('--comment <text>')}               Optional human-lock comment persisted on the task
  ${chalk.cyan('--force, -f')}                    Skip delete confirmation
  ${chalk.cyan('--dry-run')}                      Preview delete without mutating the server
  ${chalk.cyan('--no-interactive')}               Fail instead of prompting; pair with --force for agents
  ${chalk.cyan('--verbose, -v')}                  Show extra fields in list/show output

${chalk.bold('Examples:')}
  ${chalk.green('aha tasks list --team team_123')}
  ${chalk.green('aha tasks create --team team_123 --title "Implement CLI command" --priority high')}
  ${chalk.green('aha tasks update task_123 --team team_123 --status review --session user-session --role user')}
  ${chalk.green('aha tasks complete task_123 --team team_123 --session builder-1')}
  ${chalk.green('aha tasks lock task_123 --team team_123 --session user-session --mode manual-status --reason "Human is editing"')}
  ${chalk.green('aha tasks unlock task_123 --team team_123 --session user-session')}
  ${chalk.green('aha task done task_123 --team team_123 --session builder-1')}
`);
}

export async function handleTasksCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    showTasksHelp();
    return;
  }

  const api = await createApiClient();
  const positional = getPositionalArgs(args);
  const asJson = hasFlag(args, '--json');
  const verbose = hasFlag(args, '--verbose', '-v');

  try {
    switch (subcommand) {
      case 'list':
        await listTasks(api, resolveTeamId(args), {
          status: parseEnumOption(args, 'status', TASK_STATUSES),
          assigneeId: getOption(args, 'assignee'),
          asJson,
          verbose,
        });
        break;
      case 'show':
        if (positional.length < 2) {
          throw new Error('Usage: aha tasks show <taskId> --team <teamId>');
        }
        await showTask(api, resolveTeamId(args), positional[1], { asJson, verbose });
        break;
      case 'create':
        await createTask(api, resolveTeamId(args), buildTaskPayload(args, false), asJson, verbose);
        break;
      case 'update':
        if (positional.length < 2) {
          throw new Error('Usage: aha tasks update <taskId> --team <teamId> [fields...]');
        }
        await updateTask(api, resolveTeamId(args), positional[1], buildTaskPayload(args, true), resolveSessionId(args), getOption(args, 'role') || 'user', getOption(args, 'name'), asJson, verbose);
        break;
      case 'delete':
        if (positional.length < 2) {
          throw new Error('Usage: aha tasks delete <taskId> --team <teamId> [--force]');
        }
        await deleteTask(api, resolveTeamId(args), positional[1], hasFlag(args, '--force', '-f'), asJson, hasFlag(args, '--dry-run'));
        break;
      case 'start':
        if (positional.length < 2) {
          throw new Error('Usage: aha tasks start <taskId> --team <teamId> [--session <id>] [--role builder]');
        }
        await startTask(api, resolveTeamId(args), positional[1], resolveSessionId(args), getOption(args, 'role') || 'builder', asJson, verbose);
        break;
      case 'complete':
      case 'done':
        if (positional.length < 2) {
          throw new Error('Usage: aha tasks complete|done <taskId> --team <teamId> [--session <id>]');
        }
        await completeTask(api, resolveTeamId(args), positional[1], resolveSessionId(args), asJson, verbose);
        break;
      case 'lock':
        if (positional.length < 2) {
          throw new Error('Usage: aha tasks lock <taskId> --team <teamId> [--session <id>] [--mode viewing|editing|manual-status]');
        }
        await setTaskHumanLock(api, resolveTeamId(args), positional[1], {
          sessionId: resolveSessionId(args),
          role: getOption(args, 'role') || 'user',
          displayName: getOption(args, 'name'),
          mode: parseEnumOption(args, 'mode', HUMAN_LOCK_MODES) || 'manual-status',
          reason: getOption(args, 'reason'),
          comment: getOption(args, 'comment'),
        }, asJson, verbose);
        break;
      case 'unlock':
        if (positional.length < 2) {
          throw new Error('Usage: aha tasks unlock <taskId> --team <teamId> [--session <id>]');
        }
        await clearTaskHumanLock(api, resolveTeamId(args), positional[1], {
          sessionId: resolveSessionId(args),
          role: getOption(args, 'role') || 'user',
          displayName: getOption(args, 'name'),
          comment: getOption(args, 'comment'),
        }, asJson, verbose);
        break;
      default:
        throw new Error(`Unknown tasks command: ${subcommand}`);
    }
  } catch (error) {
    logger.debug('[TasksCommand] Error:', error);
    printCliCommandError(error);
    process.exit(getCliCommandExitCode(error));
  }
}

async function listTasks(
  api: ApiClient,
  teamId: string,
  opts: { status?: TaskStatus; assigneeId?: string; asJson: boolean; verbose: boolean },
): Promise<void> {
  const result = await api.listTasks(teamId, {
    status: opts.status,
    assigneeId: opts.assigneeId,
  });

  if (opts.asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!result.tasks.length) {
    console.log(chalk.yellow(`No tasks found for team ${teamId}.`));
    return;
  }

  console.log(chalk.bold(`\nTasks (${result.tasks.length}) for ${teamId}\n`));
  for (const task of result.tasks) {
    printTask(task, opts.verbose);
  }
  console.log();
}

async function showTask(
  api: ApiClient,
  teamId: string,
  taskId: string,
  opts: { asJson: boolean; verbose: boolean },
): Promise<void> {
  const task = await api.getTask(teamId, taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  if (opts.asJson) {
    console.log(JSON.stringify(task, null, 2));
    return;
  }

  console.log(chalk.bold(`\nTask ${taskId}\n`));
  printTask(task, true);
  console.log();
}

async function createTask(
  api: ApiClient,
  teamId: string,
  payload: Record<string, unknown>,
  asJson: boolean,
  verbose: boolean,
): Promise<void> {
  const result = await api.createTask(teamId, payload);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.green(t('task.createSuccess')));
  printTask(result.task, verbose);
  console.log();
}

async function updateTask(
  api: ApiClient,
  teamId: string,
  taskId: string,
  payload: Record<string, unknown>,
  sessionId: string,
  role: string,
  displayName: string | undefined,
  asJson: boolean,
  verbose: boolean,
): Promise<void> {
  const result = await api.updateTask(teamId, taskId, {
    ...payload,
    actor: {
      sessionId,
      role,
      ...(displayName ? { displayName } : {}),
      kind: role === 'user' ? 'human' : 'agent',
    },
  });

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.green(t('task.updateSuccess', { taskId })));
  printTask(result.task, verbose);
  console.log();
}

async function deleteTask(
  api: ApiClient,
  teamId: string,
  taskId: string,
  force: boolean,
  asJson: boolean,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    printCliDryRunPreview(
      {
        action: 'tasks.delete',
        summary: `Would delete task ${taskId} from team ${teamId}.`,
        target: { teamId, taskId },
      },
      { asJson },
    );
    return;
  }

  if (!force) {
    const confirmed = await confirm(`Delete task ${taskId}? (y/N): `);
    if (!confirmed) {
      console.log(chalk.yellow(t('common.operationCancelled')));
      return;
    }
  }

  await api.deleteTask(teamId, taskId);
  console.log(chalk.green(t('task.deleteSuccess', { taskId })));
}

async function startTask(
  api: ApiClient,
  teamId: string,
  taskId: string,
  sessionId: string,
  role: string,
  asJson: boolean,
  verbose: boolean,
): Promise<void> {
  const result = await api.startTask(teamId, taskId, sessionId, role);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.green(t('task.startSuccess', { taskId, sessionId })));
  printTask(result.task, verbose);
  console.log();
}

async function completeTask(
  api: ApiClient,
  teamId: string,
  taskId: string,
  sessionId: string,
  asJson: boolean,
  verbose: boolean,
): Promise<void> {
  const result = await api.completeTask(teamId, taskId, sessionId);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.green(t('task.completeSuccess', { taskId, sessionId })));
  printTask(result.task, verbose);
  console.log();
}


async function setTaskHumanLock(
  api: ApiClient,
  teamId: string,
  taskId: string,
  payload: {
    sessionId: string;
    role: string;
    displayName?: string;
    mode: 'viewing' | 'editing' | 'manual-status';
    reason?: string;
    comment?: string;
  },
  asJson: boolean,
  verbose: boolean,
): Promise<void> {
  const result = await api.setTaskHumanStatusLock(teamId, taskId, {
    ...payload,
    kind: payload.role === 'user' ? 'human' : 'agent',
  });

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.green(t('task.lockSet', { taskId })));
  printTask(result.task, verbose);
  console.log();
}

async function clearTaskHumanLock(
  api: ApiClient,
  teamId: string,
  taskId: string,
  payload: {
    sessionId: string;
    role: string;
    displayName?: string;
    comment?: string;
  },
  asJson: boolean,
  verbose: boolean,
): Promise<void> {
  const result = await api.clearTaskHumanStatusLock(teamId, taskId, {
    ...payload,
    kind: payload.role === 'user' ? 'human' : 'agent',
  });

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.green(t('task.lockCleared', { taskId })));
  printTask(result.task, verbose);
  console.log();
}
