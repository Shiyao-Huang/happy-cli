/**
 * Team management commands for Aha CLI
 */

import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { DEFAULT_KANBAN_BOARD } from '@/claude/team/roles.config';
import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { readCredentials } from '@/persistence';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { stopDaemonTeamSessions, checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient';
import {
  deriveRoleIdFromGenomeRef,
  fetchMarketplaceGenomeDetail,
  parseCorpsSpecFromGenome,
} from '@/utils/genomeMarketplace';
import { confirmPrompt, getCliCommandExitCode, printCliCommandError, printCliDryRunPreview } from './globalCli';

interface TeamCommandOptions {
  force?: boolean;
  verbose?: boolean;
  asJson?: boolean;
  dryRun?: boolean;
}

const TEAM_TASK_STATUSES = ['todo', 'in-progress', 'review', 'blocked', 'done'] as const;
type TeamTaskStatus = (typeof TEAM_TASK_STATUSES)[number];

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
  const booleanFlags = new Set(['--force', '-f', '--verbose', '-v', '--json', '--help', '-h', '--no-spawn', '--dry-run']);

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

function parseCsvOption(args: string[], name: string): string[] | undefined {
  const raw = getOption(args, name);
  if (!raw) {
    return undefined;
  }

  const values = raw
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  return values.length > 0 ? values : undefined;
}

async function confirm(prompt: string): Promise<boolean> {
  return confirmPrompt(prompt, { forceFlagName: '--force' });
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

async function stopTeamSessionsInDaemon(teamId: string, silent = false): Promise<void> {
  try {
    const isRunning = await checkIfDaemonRunningAndCleanupStaleState();
    if (!isRunning) {
      logger.debug('[Teams] Daemon not running, no local sessions to stop');
      return;
    }

    if (!silent) {
      console.log(chalk.gray(`Stopping local daemon sessions for team ${teamId}...`));
    }
    const result = await stopDaemonTeamSessions(teamId);

    if (!silent && result.stopped > 0) {
      console.log(chalk.gray(`Stopped ${result.stopped} local session(s)`));
    }
    if (result.errors.length > 0) {
      logger.debug('[Teams] Errors stopping sessions:', result.errors);
    }
  } catch (error) {
    logger.debug('[Teams] Failed to stop daemon sessions (non-fatal):', error);
  }
}

function printMember(member: any): void {
  const label = member.displayName || member.sessionId || member.memberId || 'unknown';
  const role = member.roleId || member.role || 'member';
  const executionPlane = member.executionPlane ? ` / ${member.executionPlane}` : '';
  console.log(chalk.gray(`  - ${label} (${role}${executionPlane})`));
}

function printTeam(team: any, verbose = false): void {
  console.log(chalk.bold.white(`Team: ${team.name || team.id}`));
  console.log(chalk.gray(`ID: ${team.id}`));
  console.log(chalk.gray(`Created: ${new Date(team.createdAt).toLocaleString()}`));
  console.log(chalk.gray(`Updated: ${new Date(team.updatedAt).toLocaleString()}`));
  console.log(chalk.gray(`Members: ${team.memberCount ?? team.members?.length ?? 0}`));
  console.log(chalk.gray(`Tasks: ${team.taskCount ?? 0}`));

  if (verbose && Array.isArray(team.members) && team.members.length > 0) {
    console.log(chalk.gray('Member roster:'));
    for (const member of team.members) {
      printMember(member);
    }
  }
}

export function summarizeTasksByStatus(tasks: any[]): { total: number; byStatus: Record<TeamTaskStatus, number> } {
  const byStatus = Object.fromEntries(
    TEAM_TASK_STATUSES.map(status => [status, 0]),
  ) as Record<TeamTaskStatus, number>;

  for (const task of tasks) {
    const status = typeof task?.status === 'string' && (TEAM_TASK_STATUSES as readonly string[]).includes(task.status)
      ? (task.status as TeamTaskStatus)
      : 'todo';
    byStatus[status] += 1;
  }

  return { total: tasks.length, byStatus };
}

function resolveStatusTeamId(args: string[], positional: string[]): string {
  const teamId = getOption(args, 'team') || positional[1] || process.env.AHA_ROOM_ID;
  if (!teamId) {
    throw new Error('Usage: aha teams status [teamId] [--team <teamId>] (or set AHA_ROOM_ID)');
  }
  return teamId;
}

function colorizeTeamTaskStatus(status: TeamTaskStatus): string {
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
      return chalk.gray(status);
  }
}

function printTaskHeadline(task: any): void {
  const taskId = task.id || 'unknown';
  const title = task.title || '(untitled)';
  const priority = task.priority || 'medium';
  const status = typeof task.status === 'string' && (TEAM_TASK_STATUSES as readonly string[]).includes(task.status)
    ? (task.status as TeamTaskStatus)
    : 'todo';

  console.log(`${chalk.bold(taskId)} ${colorizeTeamTaskStatus(status)} ${chalk.cyan(`[${priority}]`)} ${chalk.white(title)}`);
}

function collectTeamIds(args: string[], positional: string[]): string[] {
  const idsFromFlag = parseCsvOption(args, 'ids');
  if (idsFromFlag && idsFromFlag.length > 0) {
    return idsFromFlag;
  }
  return positional.slice(1).map(value => value.trim()).filter(Boolean);
}

function buildCreateTeamPayload(args: string[], positional: string[]): { teamId: string; name: string; goal?: string; sessionIds: string[] } {
  const positionalName = positional.slice(1).join(' ').trim();
  const name = getOption(args, 'name') || positionalName;
  if (!name) {
    throw new Error('Usage: aha teams create --name "Team Name" [--id teamId] [--goal "..."] [--sessions a,b]');
  }

  return {
    teamId: getOption(args, 'id') || randomUUID(),
    name,
    goal: getOption(args, 'goal'),
    sessionIds: parseCsvOption(args, 'sessions') || [],
  };
}

async function resolveTeamSessionIds(api: ApiClient, teamId: string): Promise<string[]> {
  const sessionIds = new Set<string>();

  const team = await api.getTeam(teamId).catch(() => null);
  if (team?.team?.members) {
    for (const member of team.team.members) {
      if (typeof member?.sessionId === 'string' && member.sessionId.length > 0) {
        sessionIds.add(member.sessionId);
      }
    }
  }

  if (sessionIds.size === 0) {
    try {
      const artifact = await api.getArtifact(teamId);
      const headerSessions = Array.isArray((artifact.header as any)?.sessions) ? (artifact.header as any).sessions : [];
      for (const sessionId of headerSessions) {
        if (typeof sessionId === 'string' && sessionId.length > 0) {
          sessionIds.add(sessionId);
        }
      }

      const bodyMembers = Array.isArray((artifact.body as any)?.team?.members) ? (artifact.body as any).team.members : [];
      for (const member of bodyMembers) {
        if (typeof member?.sessionId === 'string' && member.sessionId.length > 0) {
          sessionIds.add(member.sessionId);
        }
      }
    } catch (error) {
      logger.debug(`[Teams] Failed to resolve team session IDs for ${teamId}:`, error);
    }
  }

  return [...sessionIds];
}

async function syncSessionMetadataToTeam(api: ApiClient, teamId: string, sessionId: string, roleId: string, displayName?: string): Promise<void> {
  try {
    const session = await api.getSession(sessionId);
    if (!session?.isDecrypted || !session.metadata) {
      console.error(chalk.yellow(`Warning: added member ${sessionId} to team, but session metadata could not be decrypted for metadata sync.`));
      return;
    }

    const nextMetadata = {
      ...session.metadata,
      teamId,
      role: roleId,
      ...(displayName ? { name: displayName } : {}),
    };

    await api.updateSessionMetadata(sessionId, nextMetadata, session.metadataVersion);
  } catch (error) {
    console.error(chalk.yellow(`Warning: team member added but failed to sync session metadata for ${sessionId}: ${error instanceof Error ? error.message : 'Unknown error'}`));
  }
}

async function clearSessionMetadataTeam(api: ApiClient, teamId: string, sessionId: string): Promise<void> {
  try {
    const session = await api.getSession(sessionId);
    if (!session?.isDecrypted || !session.metadata) {
      console.error(chalk.yellow(`Warning: removed member ${sessionId}, but session metadata could not be decrypted for cleanup.`));
      return;
    }

    if (session.metadata.teamId !== teamId) {
      return;
    }

    const nextMetadata = { ...session.metadata };
    delete nextMetadata.teamId;
    delete nextMetadata.roomId;
    delete nextMetadata.roomName;

    await api.updateSessionMetadata(sessionId, nextMetadata, session.metadataVersion);
  } catch (error) {
    console.error(chalk.yellow(`Warning: member removed but failed to clean session metadata for ${sessionId}: ${error instanceof Error ? error.message : 'Unknown error'}`));
  }
}

export function showTeamsHelp() {
  console.log(`
${chalk.bold.cyan('Aha Teams')} - Team management commands

${chalk.bold('Usage:')}
  ${chalk.green('aha teams')} <command> [options]
  ${chalk.green('aha team')} <command> [options]

${chalk.bold('Commands:')}
  ${chalk.yellow('list')}                          List all teams
  ${chalk.yellow('show')} <teamId>                 Show one team and its roster
  ${chalk.yellow('status')} [teamId]               Show team + Kanban status summary
  ${chalk.yellow('create')}                        Create a team artifact
  ${chalk.yellow('spawn')}                         Create team + spawn agents from preset (P0)
  ${chalk.yellow('publish-template')}              Publish a LegionImage JSON file to the marketplace
  ${chalk.yellow('members')} <teamId>              List team members
  ${chalk.yellow('add-member')} <teamId>           Add a member to a team
  ${chalk.yellow('remove-member')} <teamId>        Remove a member from a team
  ${chalk.yellow('rename')} <teamId> <name>        Rename a team
  ${chalk.yellow('archive')} <teamId>              Archive a team and its sessions
  ${chalk.yellow('unarchive')} <teamId>            Restore an archived team and its sessions
  ${chalk.yellow('delete')} <teamId>               Delete a team and its sessions
  ${chalk.yellow('batch-archive')} <id...>         Archive multiple teams
  ${chalk.yellow('batch-delete')} <id...>          Delete multiple teams

${chalk.bold('Common options:')}
  ${chalk.cyan('--json')}                         Print raw JSON output
  ${chalk.cyan('--format <json|table>')}         Select JSON or human output mode
  ${chalk.cyan('--verbose, -v')}                  Show detailed member output
  ${chalk.cyan('--force, -f')}                    Skip archive/delete confirmation
  ${chalk.cyan('--dry-run')}                      Preview archive/delete/unarchive without mutating the server
  ${chalk.cyan('--no-interactive')}               Fail instead of prompting; pair with --force for agents

${chalk.bold('Create options:')}
  ${chalk.cyan('--name "Team Name"')}            Team name (or pass as positional text)
  ${chalk.cyan('--id <teamId>')}                  Optional explicit team ID (default: random UUID)
  ${chalk.cyan('--goal <text>')}                  Seed a goal task in the board
  ${chalk.cyan('--sessions a,b,c')}               Seed members from existing session IDs

${chalk.bold('Spawn options (P0 — one-command team bootstrap):')}
  ${chalk.cyan('--preset <name>')}                Preset: deployment | dev | review | minimal
  ${chalk.cyan('--template <id|@ns/name[:v]>')}   Marketplace corps/team-template to instantiate
  ${chalk.cyan('--name "Team Name"')}             Team name (default: preset name)
  ${chalk.cyan('--team <teamId>')}                Add agents to existing team instead of creating new
  ${chalk.cyan('--path <cwd>')}                   Working directory for spawned agents
  ${chalk.cyan('--model claude|codex')}           Runtime model for all agents (default: claude)
  ${chalk.cyan('--no-spawn')}                     Create the team from template without immediately spawning members

${chalk.bold('Publish-template options:')}
  ${chalk.cyan('--file <path>')}                  Path to a .corps.json file
  ${chalk.cyan('--name <templateName>')}          Optional marketplace name override
  ${chalk.cyan('--namespace <scope>')}            Optional namespace override (default from file or @public)
  ${chalk.cyan('--description <text>')}           Optional description override
  ${chalk.cyan('--version <n>')}                  Optional version override
  ${chalk.cyan('--tags <json-array>')}            Optional tags override, e.g. '["corps","gstack"]'

${chalk.bold('Member options:')}
  ${chalk.cyan('--session <sessionId>')}          Session ID for add-member/remove-member
  ${chalk.cyan('--role <roleId>')}                Role ID for add-member (default: member)
  ${chalk.cyan('--name <displayName>')}           Display name for add-member
  ${chalk.cyan('--member-id <id>')}               Optional stable member ID
  ${chalk.cyan('--session-tag <tag>')}            Optional session tag
  ${chalk.cyan('--spec-id <genomeId>')}           Optional genome spec ID
  ${chalk.cyan('--parent-session <id>')}          Optional parent session ID
  ${chalk.cyan('--execution-plane <mode>')}       Optional execution plane (mainline|bypass)
  ${chalk.cyan('--runtime-type <runtime>')}       Optional runtime type (claude|codex)

${chalk.bold('Batch options:')}
  ${chalk.cyan('--ids a,b,c')}                    Alternative to positional IDs for batch ops

${chalk.bold('Examples:')}
  ${chalk.green('aha teams list --verbose')}
  ${chalk.green('aha teams create --name "Sprint Crew" --goal "Ship CLI CRUD"')}
  ${chalk.green('aha team status team_123')}
  ${chalk.green('aha teams spawn --preset deployment --name "Deploy Crew"')}
  ${chalk.green('aha teams spawn --preset dev --team existing-team-id')}
  ${chalk.green('aha teams spawn --template @public/fullstack-squad:1 --name "Fullstack Squad"')}
  ${chalk.green('aha teams publish-template --file examples/gstack-teams/gstack-trio.corps.json --namespace @official')}
  ${chalk.green('aha teams show team_123')}
  ${chalk.green('aha teams add-member team_123 --session sess_1 --role builder --name "Builder 2"')}
  ${chalk.green('aha teams archive team_123 --force')}
`);
}

export async function handleTeamsCommand(args: string[]) {
  const subcommand = args[0];

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    showTeamsHelp();
    return;
  }

  const options: TeamCommandOptions = {
    force: hasFlag(args, '--force', '-f'),
    verbose: hasFlag(args, '--verbose', '-v'),
    asJson: hasFlag(args, '--json'),
    dryRun: hasFlag(args, '--dry-run'),
  };

  const api = await createApiClient();
  const positional = getPositionalArgs(args);

  try {
    switch (subcommand) {
      case 'list':
        await listTeams(api, options);
        break;
      case 'show':
        if (positional.length < 2) {
          throw new Error('Usage: aha teams show <teamId>');
        }
        await showTeam(api, positional[1], options);
        break;
      case 'status':
        await showTeamStatus(api, resolveStatusTeamId(args, positional), options);
        break;
      case 'create':
        await createTeam(api, buildCreateTeamPayload(args, positional), options);
        break;
      case 'spawn': {
        const preset = getOption(args, 'preset');
        const template = getOption(args, 'template');
        if (!preset && !template) {
          throw new Error('Usage: aha teams spawn (--preset <deployment|dev|review|minimal> | --template <id|@ns/name[:v]>) [--name "..."] [--team <id>] [--path <cwd>] [--model claude|codex] [--no-spawn]');
        }
        if (preset && template) {
          throw new Error('Use either --preset or --template, not both.');
        }
        if (template) {
          await spawnTeamFromTemplate(api, template, {
            teamId: getOption(args, 'team'),
            name: getOption(args, 'name'),
            cwd: getOption(args, 'path') || getOption(args, 'cwd') || process.cwd(),
            model: (getOption(args, 'model') || 'claude') as 'claude' | 'codex',
            spawnAgents: !hasFlag(args, '--no-spawn'),
            asJson: options.asJson,
          });
        } else {
          await spawnTeamWithPreset(api, preset!, {
            teamId: getOption(args, 'team'),
            name: getOption(args, 'name'),
            cwd: getOption(args, 'path') || getOption(args, 'cwd') || process.cwd(),
            model: (getOption(args, 'model') || 'claude') as 'claude' | 'codex',
            asJson: options.asJson,
          });
        }
        break;
      }
      case 'publish-template':
        await publishTemplateFromFile(api, args, positional, options);
        break;
      case 'members':
        if (positional.length < 2) {
          throw new Error('Usage: aha teams members <teamId>');
        }
        await listMembers(api, positional[1], options);
        break;
      case 'add-member':
        if (positional.length < 2) {
          throw new Error('Usage: aha teams add-member <teamId> --session <sessionId> [--role builder]');
        }
        await addMember(api, positional[1], args, options);
        break;
      case 'remove-member':
        if (positional.length < 2) {
          throw new Error('Usage: aha teams remove-member <teamId> --session <sessionId>');
        }
        await removeMember(api, positional[1], args, options);
        break;
      case 'archive':
        if (positional.length < 2) {
          throw new Error('Usage: aha teams archive <teamId> [--force]');
        }
        await archiveTeam(api, positional[1], options);
        break;
      case 'unarchive':
        if (positional.length < 2) {
          throw new Error('Usage: aha teams unarchive <teamId> [--force]');
        }
        await unarchiveTeamCmd(api, positional[1], options);
        break;
      case 'delete':
        if (positional.length < 2) {
          throw new Error('Usage: aha teams delete <teamId> [--force]');
        }
        await deleteTeam(api, positional[1], options);
        break;
      case 'rename':
        if (positional.length < 3) {
          throw new Error('Usage: aha teams rename <teamId> <name>');
        }
        await renameTeam(api, positional[1], positional.slice(2).join(' '), options);
        break;
      case 'batch-archive': {
        const teamIds = collectTeamIds(args, positional);
        if (teamIds.length === 0) {
          throw new Error('Usage: aha teams batch-archive <teamId...> [--ids a,b,c]');
        }
        await batchArchiveTeams(api, teamIds, options);
        break;
      }
      case 'batch-delete': {
        const teamIds = collectTeamIds(args, positional);
        if (teamIds.length === 0) {
          throw new Error('Usage: aha teams batch-delete <teamId...> [--ids a,b,c]');
        }
        await batchDeleteTeams(api, teamIds, options);
        break;
      }
      case 'messages': {
        if (positional.length < 2) {
          throw new Error('Usage: aha teams messages <teamId> [--limit N] [--before cursor]');
        }
        await showTeamMessages(api, positional[1], {
          limit: parseInt(getOption(args, 'limit') || '20', 10),
          before: getOption(args, 'before'),
          asJson: options.asJson,
        });
        break;
      }
      case 'send': {
        if (positional.length < 2) {
          throw new Error('Usage: aha teams send <teamId> "<message>" [--type chat|notification]');
        }
        const content = positional.slice(2).join(' ');
        if (!content) {
          throw new Error('Message content is required');
        }
        await sendTeamMessageCmd(api, positional[1], content, {
          type: (getOption(args, 'type') || 'chat') as 'chat' | 'notification',
          asJson: options.asJson,
        });
        break;
      }
      default:
        throw new Error(`Unknown teams command: ${subcommand}`);
    }
  } catch (error) {
    logger.debug('[TeamsCommand] Error:', error);
    printCliCommandError(error);
    process.exit(getCliCommandExitCode(error));
  }
}

async function showTeamMessages(api: ApiClient, teamId: string, options: { limit: number; before?: string; asJson?: boolean }): Promise<void> {
  const result = await api.getTeamMessages(teamId, { limit: options.limit, before: options.before });
  const messages = result.messages ?? [];

  if (options.asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (messages.length === 0) {
    console.log(chalk.yellow('No messages found'));
    return;
  }

  console.log(chalk.bold(`\nTeam messages for ${teamId} (${messages.length}):\n`));
  for (const msg of messages) {
    const sender = chalk.cyan(msg.senderDisplayName ?? msg.senderRole ?? 'system');
    const type = msg.type && msg.type !== 'chat' ? chalk.gray(`[${msg.type}] `) : '';
    const ts = msg.timestamp ? chalk.gray(new Date(msg.timestamp).toLocaleTimeString()) : '';
    const content = (msg.content ?? '').slice(0, 500);
    console.log(`${ts} ${sender}: ${type}${content}`);
  }
  if (result.cursor) {
    console.log(chalk.gray(`\n  (more messages available — use --before ${result.cursor})`));
  }
}

async function sendTeamMessageCmd(api: ApiClient, teamId: string, content: string, options: { type: 'chat' | 'notification'; asJson?: boolean }): Promise<void> {
  await api.sendTeamMessage(teamId, {
    id: randomUUID(),
    teamId,
    type: options.type,
    content,
    fromDisplayName: 'CLI Operator',
    fromRole: 'operator',
    timestamp: Date.now(),
  });

  if (options.asJson) {
    console.log(JSON.stringify({ success: true, teamId, content }, null, 2));
    return;
  }
  console.log(chalk.green(`✓ Message sent to team ${teamId}`));
}

async function listTeams(api: ApiClient, options: TeamCommandOptions): Promise<void> {
  if (!options.asJson) {
    console.log(chalk.cyan('Fetching teams...'));
  }
  const result = await api.listTeams();
  const teams = result.teams || [];

  if (options.asJson) {
    if (!options.verbose) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const expanded = await Promise.all(teams.map(async (team: any) => (await api.getTeam(team.id))?.team || team));
    console.log(JSON.stringify({ teams: expanded }, null, 2));
    return;
  }

  if (teams.length === 0) {
    console.log(chalk.yellow('No teams found'));
    return;
  }

  console.log(chalk.bold(`\nFound ${teams.length} team(s):\n`));

  for (const team of teams) {
    console.log(chalk.green('━'.repeat(60)));
    const expandedTeam = options.verbose ? (await api.getTeam(team.id))?.team || team : team;
    printTeam(expandedTeam, !!options.verbose);
  }

  console.log(chalk.green('━'.repeat(60)));
  console.log();
}

async function showTeam(api: ApiClient, teamId: string, options: TeamCommandOptions): Promise<void> {
  const result = await api.getTeam(teamId);
  if (!result?.team) {
    throw new Error(`Team ${teamId} not found`);
  }

  if (options.asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.bold(`\nTeam ${teamId}\n`));
  printTeam(result.team, true);
  console.log();
}

async function showTeamStatus(api: ApiClient, teamId: string, options: TeamCommandOptions): Promise<void> {
  const result = await api.getTeam(teamId);
  if (!result?.team) {
    throw new Error(`Team ${teamId} not found`);
  }

  const taskResult = await api.listTasks(teamId);
  const tasks = taskResult.tasks || [];
  const summary = summarizeTasksByStatus(tasks);

  if (options.asJson) {
    console.log(JSON.stringify({
      team: result.team,
      summary,
      tasks,
    }, null, 2));
    return;
  }

  console.log(chalk.bold(`\nTeam status for ${teamId}\n`));
  printTeam(result.team, !!options.verbose);
  console.log(chalk.bold('\nTask summary'));
  for (const status of TEAM_TASK_STATUSES) {
    console.log(chalk.gray(`  ${colorizeTeamTaskStatus(status)}: ${summary.byStatus[status]}`));
  }
  console.log(chalk.gray(`  total: ${summary.total}`));

  const openTasks = tasks.filter((task: any) => task?.status !== 'done');
  if (openTasks.length === 0) {
    console.log(chalk.green('\nNo open tasks.\n'));
    return;
  }

  const visibleTasks = options.verbose ? openTasks : openTasks.slice(0, 10);
  console.log(chalk.bold(`\nOpen tasks (${openTasks.length})\n`));
  for (const task of visibleTasks) {
    printTaskHeadline(task);
  }
  if (!options.verbose && openTasks.length > visibleTasks.length) {
    console.log(chalk.gray(`\n…and ${openTasks.length - visibleTasks.length} more. Use --verbose to show all open tasks.`));
  }
  console.log();
}

async function createTeam(
  api: ApiClient,
  payload: { teamId: string; name: string; goal?: string; sessionIds: string[] },
  options: TeamCommandOptions,
): Promise<void> {
  const board = JSON.parse(JSON.stringify(DEFAULT_KANBAN_BOARD));
  board.name = payload.name;
  if (!board.team) {
    board.team = { members: [] };
  }
  board.team.name = payload.name;
  board.team.members = payload.sessionIds.map((sessionId) => ({
    sessionId,
    roleId: 'member',
    displayName: sessionId,
    joinedAt: Date.now(),
  }));

  if (payload.goal) {
    board.tasks.push({
      id: 'team-goal',
      title: `🎯 Team Goal: ${payload.goal}`,
      description: 'This is the primary objective for this team.',
      status: 'todo',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  const artifact = await api.createArtifact(
    payload.teamId,
    {
      type: 'team',
      title: payload.name,
      name: payload.name,
      sessions: payload.sessionIds,
      draft: false,
      createdAt: Date.now(),
    },
    board,
  );

  const team = (await api.getTeam(payload.teamId))?.team || {
    id: artifact.id,
    name: payload.name,
    memberCount: board.team.members.length,
    taskCount: Array.isArray(board.tasks) ? board.tasks.length : 0,
    members: board.team.members,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };

  for (const sessionId of payload.sessionIds) {
    await syncSessionMetadataToTeam(api, payload.teamId, sessionId, 'member');
  }

  if (options.asJson) {
    console.log(JSON.stringify({ success: true, team }, null, 2));
    return;
  }

  console.log(chalk.green(`✓ Team ${payload.teamId} created successfully`));
  printTeam(team, true);
  console.log();
}

async function listMembers(api: ApiClient, teamId: string, options: TeamCommandOptions): Promise<void> {
  const result = await api.getTeam(teamId);
  if (!result?.team) {
    throw new Error(`Team ${teamId} not found`);
  }

  const members = Array.isArray(result.team.members) ? result.team.members : [];

  if (options.asJson) {
    console.log(JSON.stringify({ teamId, members }, null, 2));
    return;
  }

  if (members.length === 0) {
    console.log(chalk.yellow(`Team ${teamId} has no members.`));
    return;
  }

  console.log(chalk.bold(`\nMembers for ${teamId}\n`));
  for (const member of members) {
    printMember(member);
  }
  console.log();
}

async function addMember(api: ApiClient, teamId: string, args: string[], options: TeamCommandOptions): Promise<void> {
  const sessionId = getOption(args, 'session');
  if (!sessionId) {
    throw new Error('Adding a team member requires --session <sessionId>.');
  }

  const roleId = getOption(args, 'role') || 'member';
  const displayName = getOption(args, 'name');

  const result = await api.addTeamMember(
    teamId,
    sessionId,
    roleId,
    displayName,
    {
      memberId: getOption(args, 'member-id'),
      sessionTag: getOption(args, 'session-tag'),
      specId: getOption(args, 'spec-id'),
      parentSessionId: getOption(args, 'parent-session'),
      executionPlane: getOption(args, 'execution-plane'),
      runtimeType: getOption(args, 'runtime-type'),
    },
  );

  await syncSessionMetadataToTeam(api, teamId, sessionId, roleId, displayName);

  if (options.asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.green(`✓ Added ${sessionId} to team ${teamId}`));
  printMember(result.member);
  console.log();
}

async function removeMember(api: ApiClient, teamId: string, args: string[], options: TeamCommandOptions): Promise<void> {
  const sessionId = getOption(args, 'session');
  if (!sessionId) {
    throw new Error('Removing a team member requires --session <sessionId>.');
  }

  const result = await api.removeTeamMember(teamId, sessionId);
  await clearSessionMetadataTeam(api, teamId, sessionId);

  if (options.asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.green(`✓ Removed ${sessionId} from team ${teamId}`));
  console.log();
}

async function archiveTeam(api: ApiClient, teamId: string, options: TeamCommandOptions): Promise<void> {
  if (options.dryRun) {
    printCliDryRunPreview(
      {
        action: 'teams.archive',
        summary: `Would archive team ${teamId} and stop its local daemon sessions.`,
        target: { teamId },
        payload: { stopDaemonSessions: true, archiveMemberSessions: true },
      },
      { asJson: options.asJson },
    );
    return;
  }

  if (!options.force) {
    const confirmed = await confirm(`Archive team ${teamId}? (y/N): `);
    if (!confirmed) {
      console.log(chalk.yellow('Operation cancelled'));
      return;
    }
  }

  const sessionIds = await resolveTeamSessionIds(api, teamId);
  await stopTeamSessionsInDaemon(teamId, !!options.asJson);
  const result = await api.archiveTeam(teamId, sessionIds);

  if (options.asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.green('✓ Team archived successfully'));
  console.log(chalk.gray(`Archived ${result.archivedSessions} session(s)`));
  console.log();
}

async function unarchiveTeamCmd(api: ApiClient, teamId: string, options: TeamCommandOptions): Promise<void> {
  if (options.dryRun) {
    printCliDryRunPreview(
      {
        action: 'teams.unarchive',
        summary: `Would restore archived team ${teamId}.`,
        target: { teamId },
      },
      { asJson: options.asJson },
    );
    return;
  }

  if (!options.force) {
    const confirmed = await confirm(`Restore archived team ${teamId}? (y/N): `);
    if (!confirmed) {
      console.log(chalk.yellow('Operation cancelled'));
      return;
    }
  }

  const result = await api.unarchiveTeam(teamId);

  if (options.asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.green('✓ Team restored successfully'));
  console.log(chalk.gray(`Restored ${result.restoredSessions} session(s)`));
  console.log();
}

async function deleteTeam(api: ApiClient, teamId: string, options: TeamCommandOptions): Promise<void> {
  if (options.dryRun) {
    printCliDryRunPreview(
      {
        action: 'teams.delete',
        summary: `Would delete team ${teamId} and stop its local daemon sessions.`,
        target: { teamId },
        payload: { stopDaemonSessions: true, deleteMemberSessions: true },
      },
      { asJson: options.asJson },
    );
    return;
  }

  if (!options.force) {
    const confirmed = await confirm(`Delete team ${teamId}? This cannot be undone. (y/N): `);
    if (!confirmed) {
      console.log(chalk.yellow('Operation cancelled'));
      return;
    }
  }

  const sessionIds = await resolveTeamSessionIds(api, teamId);
  await stopTeamSessionsInDaemon(teamId, !!options.asJson);
  const result = await api.deleteTeam(teamId, sessionIds);

  if (options.asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.green('✓ Team deleted successfully'));
  console.log(chalk.gray(`Deleted ${result.deletedSessions} session(s)`));
  console.log();
}

async function renameTeam(api: ApiClient, teamId: string, newName: string, options: TeamCommandOptions): Promise<void> {
  const result = await api.renameTeam(teamId, newName);

  if (options.asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.green('✓ Team renamed successfully'));
  console.log(chalk.gray(`New name: ${newName}`));
  console.log();
}

async function batchArchiveTeams(api: ApiClient, teamIds: string[], options: TeamCommandOptions): Promise<void> {
  if (options.dryRun) {
    printCliDryRunPreview(
      {
        action: 'teams.batch-archive',
        summary: `Would archive ${teamIds.length} team(s).`,
        target: { teamIds },
        payload: { stopDaemonSessions: true, archiveMemberSessions: true },
      },
      { asJson: options.asJson },
    );
    return;
  }

  if (!options.force) {
    const confirmed = await confirm(`Archive ${teamIds.length} team(s)? (y/N): `);
    if (!confirmed) {
      console.log(chalk.yellow('Operation cancelled'));
      return;
    }
  }

  const results: Array<{ teamId: string; success: boolean; archivedSessions?: number; error?: string }> = [];

  for (const teamId of teamIds) {
    try {
      const sessionIds = await resolveTeamSessionIds(api, teamId);
      await stopTeamSessionsInDaemon(teamId, !!options.asJson);
      const result = await api.archiveTeam(teamId, sessionIds);
      results.push({ teamId, ...result });
    } catch (error) {
      results.push({ teamId, success: false, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  const summary = {
    success: true,
    archived: results.filter(result => result.success).length,
    results,
  };

  if (options.asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(chalk.green(`✓ Archived ${summary.archived} team(s)`));
  for (const entry of results) {
    const color = entry.success ? chalk.green : chalk.red;
    console.log(color(`  - ${entry.teamId}: ${entry.success ? `archived ${entry.archivedSessions ?? 0} sessions` : entry.error || 'failed'}`));
  }
  console.log();
}

/** Predefined team presets for `aha teams spawn --preset <name>` */
const TEAM_PRESETS: Record<string, { description: string; roles: Array<{ roleId: string; name: string }> }> = {
  deployment: {
    description: 'Deployment team: Master + DevOps Builder + QA',
    roles: [
      { roleId: 'master', name: 'Master 1' },
      { roleId: 'devops-builder', name: 'DevOps Builder' },
      { roleId: 'qa-engineer', name: 'QA Engineer' },
    ],
  },
  dev: {
    description: 'Development team: Master + Builder + Implementer + QA',
    roles: [
      { roleId: 'master', name: 'Master 1' },
      { roleId: 'builder', name: 'Builder 1' },
      { roleId: 'implementer', name: 'Implementer 1' },
      { roleId: 'qa-engineer', name: 'QA Engineer' },
    ],
  },
  review: {
    description: 'Review team: Master + Researcher + QA',
    roles: [
      { roleId: 'master', name: 'Master 1' },
      { roleId: 'researcher', name: 'Researcher 1' },
      { roleId: 'qa-engineer', name: 'QA Engineer' },
    ],
  },
  minimal: {
    description: 'Minimal team: Master + Builder',
    roles: [
      { roleId: 'master', name: 'Master 1' },
      { roleId: 'builder', name: 'Builder 1' },
    ],
  },
};

function humanizeRoleLabel(roleId: string): string {
  return roleId
    .split(/[-_]/g)
    .filter(Boolean)
    .map(segment => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

async function maybeAttachCodexToken(
  api: ApiClient,
  runtime: 'claude' | 'codex',
  spawnBody: Record<string, unknown>,
): Promise<void> {
  if (runtime !== 'codex') {
    return;
  }

  try {
    const openAiToken = await api.getVendorToken('openai');
    if (!openAiToken) {
      logger.debug('[teams spawn] No stored OpenAI token found for Codex spawn; falling back to machine-local Codex auth');
      return;
    }

    spawnBody.token = typeof openAiToken === 'string'
      ? openAiToken
      : JSON.stringify(openAiToken);
  } catch (error) {
    logger.debug('[teams spawn] Failed to attach OpenAI token for Codex spawn:', error);
  }
}

async function createTemplateBackedTeam(
  api: ApiClient,
  payload: {
    teamId: string;
    name: string;
    template: { id: string; name: string; namespace: string | null; version?: number | null };
    bootContext?: Record<string, unknown>;
  },
  options: TeamCommandOptions,
): Promise<void> {
  const board = JSON.parse(JSON.stringify(DEFAULT_KANBAN_BOARD));
  board.name = payload.name;
  board.metadata = {
    ...(board.metadata || {}),
    provenance: {
      source: 'template',
      templateGenomeId: payload.template.id,
    },
  };
  if (!board.team) {
    board.team = { members: [] };
  }
  board.team.name = payload.name;
  board.team.members = [];
  board.team.bootContext = payload.bootContext || {};
  board.team.template = {
    templateGenomeId: payload.template.id,
    namespace: payload.template.namespace,
    name: payload.template.name,
    version: payload.template.version ?? null,
  };

  const initialObjective = typeof payload.bootContext?.initialObjective === 'string'
    ? payload.bootContext.initialObjective
    : undefined;
  if (initialObjective) {
    board.tasks.push({
      id: 'team-goal',
      title: `🎯 Team Goal: ${initialObjective}`,
      description: 'This is the primary objective for this team.',
      status: 'todo',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  const artifact = await api.createArtifact(
    payload.teamId,
    {
      type: 'team',
      title: payload.name,
      name: payload.name,
      sessions: [],
      draft: false,
      createdAt: Date.now(),
    },
    board,
  );

  const team = (await api.getTeam(payload.teamId))?.team || {
    id: artifact.id,
    name: payload.name,
    memberCount: 0,
    taskCount: Array.isArray(board.tasks) ? board.tasks.length : 0,
    members: [],
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };

  if (!options.asJson) {
    console.log(chalk.green(`✓ Team ${payload.teamId} created successfully from template ${payload.template.name}`));
    printTeam(team, true);
    console.log();
  }
}

async function publishTemplateFromFile(
  api: ApiClient,
  args: string[],
  positional: string[],
  options: TeamCommandOptions,
): Promise<void> {
  const filePath = getOption(args, 'file') || positional[2];
  if (!filePath) {
    throw new Error('Usage: aha teams publish-template --file <path-to-corps.json> [--namespace @public]');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Failed to read template file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Array.isArray(parsed.members) || parsed.members.length === 0) {
    throw new Error(`Template file ${filePath} is not a valid LegionImage: expected a non-empty members array.`);
  }

  const name = getOption(args, 'name')
    || (typeof parsed.name === 'string' ? parsed.name : basename(filePath).replace(/\.corps\.json$/u, '').replace(/\.json$/u, ''));
  const description = getOption(args, 'description')
    || (typeof parsed.description === 'string' ? parsed.description : '');
  if (!description) {
    throw new Error(`Template file ${filePath} is missing description. Pass --description or add LegionImage.description.`);
  }

  const namespace = getOption(args, 'namespace') || (typeof parsed.namespace === 'string' ? parsed.namespace : '@public');
  const version = Number(getOption(args, 'version') || (typeof parsed.version === 'number' ? parsed.version : 1));
  const tagsOverride = getOption(args, 'tags');
  const tags = tagsOverride
    || (Array.isArray(parsed.tags) ? JSON.stringify(parsed.tags) : undefined);

  const normalized = {
    ...parsed,
    namespace,
    name,
    version,
    description,
    category: 'corps',
  };

  const result = await api.createCorpsTemplate({
    name,
    description,
    spec: JSON.stringify(normalized),
    namespace,
    version,
    tags,
    isPublic: true,
    publisherId: null,
  });

  if (options.asJson) {
    console.log(JSON.stringify({ success: true, filePath, genome: result.genome, corps: result.corps }, null, 2));
    return;
  }

  console.log(chalk.green(`✓ Published corps template ${namespace}/${name}@${version}`));
  console.log(chalk.gray(`Source file: ${filePath}`));
  console.log(chalk.gray(`Genome ID: ${result.genome?.id ?? 'unknown'}`));
  console.log();
}

async function spawnTeamFromTemplate(
  api: ApiClient,
  templateSpec: string,
  opts: { teamId?: string; name?: string; cwd?: string; model: 'claude' | 'codex'; spawnAgents: boolean; asJson?: boolean },
): Promise<void> {
  const templateRecord = await fetchMarketplaceGenomeDetail(templateSpec);
  if (!templateRecord) {
    throw new Error(`Template "${templateSpec}" was not found in genome marketplace.`);
  }

  const corps = parseCorpsSpecFromGenome(templateRecord);
  const repoRoot = opts.cwd || process.cwd();
  const teamName = opts.name
    || (typeof corps.bootContext?.teamDescription === 'string' && corps.bootContext.teamDescription.trim())
    || templateRecord.description
    || humanizeRoleLabel(templateRecord.name);

  let teamId = opts.teamId;
  if (!teamId) {
    teamId = randomUUID();
    if (!opts.asJson) {
      console.log(chalk.bold(`\nCreating team from template: ${teamName}\n`));
    }
    await createTemplateBackedTeam(api, {
      teamId,
      name: teamName,
      template: {
        id: templateRecord.id,
        name: templateRecord.name,
        namespace: templateRecord.namespace,
        version: templateRecord.version,
      },
      bootContext: corps.bootContext as Record<string, unknown> | undefined,
    }, { asJson: opts.asJson });
  } else if (!opts.asJson) {
    console.log(chalk.bold(`\nSpawning template members into existing team: ${teamId}\n`));
  }

  const plannedMembers = corps.members.flatMap((member) => {
    const count = Math.max(1, member.count ?? 1);
    return Array.from({ length: count }, (_, index) => ({
      genome: member.genome,
      roleId: member.roleAlias || deriveRoleIdFromGenomeRef(member.genome),
      required: member.required !== false,
      overlay: member.overlay,
      ordinal: index + 1,
      count,
    }));
  });

  if (!opts.spawnAgents) {
    const result = {
      success: true,
      teamId,
      template: {
        id: templateRecord.id,
        name: templateRecord.name,
        namespace: templateRecord.namespace,
        version: templateRecord.version ?? null,
      },
      plannedMembers,
      spawnedAgents: [],
    };
    if (opts.asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(chalk.green(`✓ Team ${teamId} created from template without spawning members`));
      console.log(chalk.gray(`Planned members: ${plannedMembers.length}`));
      console.log(chalk.gray(`Use: aha teams show ${teamId}`));
      console.log();
    }
    return;
  }

  const { ensureDaemonRunning } = await import('@/daemon/controlClient');
  const { readDaemonState } = await import('@/persistence');
  await ensureDaemonRunning();
  const daemonState = await readDaemonState();
  if (!daemonState?.httpPort) {
    throw new Error('Daemon is not running. Start it with: aha');
  }

  const spawnedAgents: Array<{ sessionId: string; roleId: string; name: string; genome: string }> = [];
  const skippedOptional = plannedMembers.filter((member) => !member.required).length;

  if (!opts.asJson) {
    console.log(chalk.cyan(`Template: ${templateRecord.namespace ?? ''}/${templateRecord.name}`));
    console.log(chalk.gray(`Planned members: ${plannedMembers.length} (${skippedOptional} optional seats deferred)\n`));
  }

  for (const member of plannedMembers) {
    if (!member.required) {
      continue;
    }

    const suffix = member.count > 1 ? ` ${member.ordinal}` : '';
    const name = `${humanizeRoleLabel(member.roleId)}${suffix}`;
    const spawnBody: Record<string, unknown> = {
      directory: repoRoot,
      agent: opts.model,
      role: member.roleId,
      sessionName: name,
      teamId,
      specId: member.genome,
    };

    await maybeAttachCodexToken(api, opts.model, spawnBody);

    try {
      const response = await fetch(`http://127.0.0.1:${daemonState.httpPort}/spawn-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spawnBody),
        signal: AbortSignal.timeout(15_000),
      });

      const result = await response.json() as { success?: boolean; sessionId?: string; error?: string };
      if (!response.ok || !result.success || !result.sessionId) {
        throw new Error(result.error || `HTTP ${response.status}`);
      }

      await api.addTeamMember(teamId, result.sessionId, member.roleId, name, {
        executionPlane: 'mainline',
        runtimeType: opts.model,
        specId: member.genome,
        ...(member.overlay ? { teamOverlay: member.overlay } : {}),
      });

      spawnedAgents.push({ sessionId: result.sessionId, roleId: member.roleId, name, genome: member.genome });

      if (!opts.asJson) {
        console.log(chalk.green(`  ✓ ${name} (${member.roleId}) → ${result.sessionId}`));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!opts.asJson) {
        console.log(chalk.red(`  ✗ ${name} (${member.roleId}): ${message}`));
      } else {
        logger.debug(`[teams spawn-template] Failed to spawn ${name}:`, error);
      }
    }
  }

  const summary = {
    success: true,
    teamId,
    template: {
      id: templateRecord.id,
      name: templateRecord.name,
      namespace: templateRecord.namespace,
      version: templateRecord.version ?? null,
    },
    plannedMembers,
    spawnedAgents,
  };

  if (opts.asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log();
  console.log(chalk.bold(`Template team ready: ${teamId}`));
  console.log(chalk.gray(`Spawned required members: ${spawnedAgents.length}/${plannedMembers.filter((member) => member.required).length}`));
  if (skippedOptional > 0) {
    console.log(chalk.gray(`Deferred optional members: ${skippedOptional}`));
  }
  console.log(chalk.gray(`Use: aha teams show ${teamId}`));
  console.log();
}

async function spawnTeamWithPreset(
  api: ApiClient,
  preset: string,
  opts: { teamId?: string; name?: string; cwd?: string; model: 'claude' | 'codex'; asJson?: boolean },
): Promise<void> {
  const presetConfig = TEAM_PRESETS[preset];
  if (!presetConfig) {
    const available = Object.keys(TEAM_PRESETS).join(', ');
    throw new Error(`Unknown preset "${preset}". Available: ${available}`);
  }

  const { ensureDaemonRunning } = await import('@/daemon/controlClient');
  const { readDaemonState } = await import('@/persistence');
  const { materializeAgentWorkspace, withDefaultAgentSkills } = await import('@/agentDocker/materializer');
  const { buildMaterializedSpawnEnv } = await import('@/agentDocker/runtimeConfig');

  const repoRoot = opts.cwd || process.cwd();

  // Step 1: resolve or create team
  let teamId = opts.teamId;
  const teamName = opts.name || `${preset.charAt(0).toUpperCase() + preset.slice(1)} Team`;

  if (!teamId) {
    teamId = randomUUID();
    if (!opts.asJson) {
      console.log(chalk.bold(`\nCreating team: ${teamName}\n`));
    }
    await createTeam(api, { teamId, name: teamName, goal: presetConfig.description, sessionIds: [] }, { asJson: opts.asJson });
  } else if (!opts.asJson) {
    console.log(chalk.bold(`\nSpawning agents into existing team: ${teamId}\n`));
  }

  // Step 2: ensure daemon running
  await ensureDaemonRunning();
  const daemonState = await readDaemonState();
  if (!daemonState?.httpPort) {
    throw new Error('Daemon is not running. Start it with: aha');
  }

  if (!opts.asJson) {
    console.log(chalk.cyan(`Preset: ${preset} — ${presetConfig.description}`));
    console.log(chalk.gray(`Spawning ${presetConfig.roles.length} agent(s)...\n`));
  }

  // Step 3: spawn each agent
  const spawnedAgents: Array<{ sessionId: string; roleId: string; name: string }> = [];

  for (const { roleId, name } of presetConfig.roles) {
    const agentId = randomUUID();
    const teamContextSuffix = `\n\n## Team Context\n- Team ID: ${teamId}\n- Your role: ${roleId}\n- On startup: call get_team_info then list_tasks\n- Kanban protocol: start_task before work, complete_task after done\n- Report blockers via send_team_message @master`;

    const config = {
      kind: 'aha.agent.v1' as const,
      name,
      runtime: opts.model,
      description: `${roleId} agent`,
      systemPromptSuffix: teamContextSuffix,
      tools: { mcpServers: ['aha'], skills: withDefaultAgentSkills() },
      env: { required: ['ANTHROPIC_API_KEY'], optional: ['AHA_ROOM_ID', 'AHA_SESSION_ID'] },
      workspace: { defaultMode: 'shared' as const, allowedModes: ['shared' as const, 'isolated' as const] },
    };

    try {
      const plan = materializeAgentWorkspace({
        agentId,
        repoRoot,
        runtime: config.runtime,
        config,
        workspaceMode: 'shared',
      });

      const materializedEnv = buildMaterializedSpawnEnv({
        settingsPath: plan.settingsPath,
        envFilePath: plan.envFilePath,
        mcpConfigPath: plan.mcpConfigPath,
        commandsDir: plan.commandsDir,
      });

      const spawnBody = {
        directory: plan.effectiveCwd,
        agent: opts.model === 'codex' ? 'codex' : 'claude',
        role: roleId,
        sessionName: name,
        teamId,
        env: materializedEnv,
      };

      await maybeAttachCodexToken(api, opts.model, spawnBody);

      const response = await fetch(`http://127.0.0.1:${daemonState.httpPort}/spawn-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spawnBody),
        signal: AbortSignal.timeout(15_000),
      });

      const result = await response.json() as { success?: boolean; sessionId?: string; error?: string };

      if (!response.ok || !result.success) {
        throw new Error(`Spawn failed: ${result.error || `HTTP ${response.status}`}`);
      }

      const sessionId = result.sessionId!;
      spawnedAgents.push({ sessionId, roleId, name });

      try {
        await api.addTeamMember(teamId, sessionId, roleId, name, {
          executionPlane: 'mainline',
          runtimeType: opts.model === 'codex' ? 'codex' : 'claude',
        });
      } catch (err) {
        logger.debug(`[teams spawn] Warning: failed to register ${roleId} in team:`, err);
      }

      if (!opts.asJson) {
        console.log(chalk.green(`  ✓ ${name} (${roleId}) → ${sessionId}`));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (opts.asJson) {
        logger.debug(`[teams spawn] Failed to spawn ${roleId}:`, err);
      } else {
        console.log(chalk.red(`  ✗ ${name} (${roleId}): ${msg}`));
      }
    }
  }

  if (opts.asJson) {
    console.log(JSON.stringify({ success: true, teamId, preset, agents: spawnedAgents }, null, 2));
    return;
  }

  console.log();
  console.log(chalk.bold(`Team spawned: ${teamId}`));
  console.log(chalk.gray(`Agents ready: ${spawnedAgents.length}/${presetConfig.roles.length}`));
  console.log(chalk.gray(`Use: aha teams show ${teamId}`));
  console.log();
}

async function batchDeleteTeams(api: ApiClient, teamIds: string[], options: TeamCommandOptions): Promise<void> {
  if (options.dryRun) {
    printCliDryRunPreview(
      {
        action: 'teams.batch-delete',
        summary: `Would delete ${teamIds.length} team(s).`,
        target: { teamIds },
        payload: { stopDaemonSessions: true, deleteMemberSessions: true },
      },
      { asJson: options.asJson },
    );
    return;
  }

  if (!options.force) {
    const confirmed = await confirm(`Delete ${teamIds.length} team(s)? This cannot be undone. (y/N): `);
    if (!confirmed) {
      console.log(chalk.yellow('Operation cancelled'));
      return;
    }
  }

  const results: Array<{ teamId: string; success: boolean; deletedSessions?: number; error?: string }> = [];

  for (const teamId of teamIds) {
    try {
      const sessionIds = await resolveTeamSessionIds(api, teamId);
      await stopTeamSessionsInDaemon(teamId, !!options.asJson);
      const result = await api.deleteTeam(teamId, sessionIds);
      results.push({ teamId, ...result });
    } catch (error) {
      results.push({ teamId, success: false, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  const summary = {
    success: true,
    deleted: results.filter(result => result.success).length,
    results,
  };

  if (options.asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(chalk.green(`✓ Deleted ${summary.deleted} team(s)`));
  for (const entry of results) {
    const color = entry.success ? chalk.green : chalk.red;
    console.log(color(`  - ${entry.teamId}: ${entry.success ? `deleted ${entry.deletedSessions ?? 0} sessions` : entry.error || 'failed'}`));
  }
  console.log();
}
