/**
 * Team management commands for Aha CLI
 */

import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import { DEFAULT_KANBAN_BOARD } from '@aha/shared-team-config';
import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { readCredentials } from '@/persistence';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { stopDaemonTeamSessions, checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient';

interface TeamCommandOptions {
  force?: boolean;
  verbose?: boolean;
  asJson?: boolean;
}

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
  const booleanFlags = new Set(['--force', '-f', '--verbose', '-v', '--json', '--help', '-h']);

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

${chalk.bold('Commands:')}
  ${chalk.yellow('list')}                          List all teams
  ${chalk.yellow('show')} <teamId>                 Show one team and its roster
  ${chalk.yellow('create')}                        Create a team artifact
  ${chalk.yellow('spawn')}                         Create team + spawn agents from preset (P0)
  ${chalk.yellow('members')} <teamId>              List team members
  ${chalk.yellow('add-member')} <teamId>           Add a member to a team
  ${chalk.yellow('remove-member')} <teamId>        Remove a member from a team
  ${chalk.yellow('rename')} <teamId> <name>        Rename a team
  ${chalk.yellow('archive')} <teamId>              Archive a team and its sessions
  ${chalk.yellow('delete')} <teamId>               Delete a team and its sessions
  ${chalk.yellow('batch-archive')} <id...>         Archive multiple teams
  ${chalk.yellow('batch-delete')} <id...>          Delete multiple teams

${chalk.bold('Common options:')}
  ${chalk.cyan('--json')}                         Print raw JSON output
  ${chalk.cyan('--verbose, -v')}                  Show detailed member output
  ${chalk.cyan('--force, -f')}                    Skip archive/delete confirmation

${chalk.bold('Create options:')}
  ${chalk.cyan('--name "Team Name"')}            Team name (or pass as positional text)
  ${chalk.cyan('--id <teamId>')}                  Optional explicit team ID (default: random UUID)
  ${chalk.cyan('--goal <text>')}                  Seed a goal task in the board
  ${chalk.cyan('--sessions a,b,c')}               Seed members from existing session IDs

${chalk.bold('Spawn options (P0 — one-command team bootstrap):')}
  ${chalk.cyan('--preset <name>')}                Preset: deployment | dev | review | minimal
  ${chalk.cyan('--name "Team Name"')}             Team name (default: preset name)
  ${chalk.cyan('--team <teamId>')}                Add agents to existing team instead of creating new
  ${chalk.cyan('--path <cwd>')}                   Working directory for spawned agents
  ${chalk.cyan('--model claude|codex')}           Runtime model for all agents (default: claude)

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
  ${chalk.green('aha teams spawn --preset deployment --name "Deploy Crew"')}
  ${chalk.green('aha teams spawn --preset dev --team existing-team-id')}
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
      case 'create':
        await createTeam(api, buildCreateTeamPayload(args, positional), options);
        break;
      case 'spawn': {
        const preset = getOption(args, 'preset');
        if (!preset) {
          throw new Error('Usage: aha teams spawn --preset <deployment|dev|review|minimal> [--name "..."] [--team <id>] [--path <cwd>] [--model claude|codex]');
        }
        await spawnTeamWithPreset(api, preset, {
          teamId: getOption(args, 'team'),
          name: getOption(args, 'name'),
          cwd: getOption(args, 'path') || getOption(args, 'cwd') || process.cwd(),
          model: (getOption(args, 'model') || 'claude') as 'claude' | 'codex',
          asJson: options.asJson,
        });
        break;
      }
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
      default:
        throw new Error(`Unknown teams command: ${subcommand}`);
    }
  } catch (error) {
    logger.debug('[TeamsCommand] Error:', error);
    console.log(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
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

async function deleteTeam(api: ApiClient, teamId: string, options: TeamCommandOptions): Promise<void> {
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
  const { materializeAgentWorkspace } = await import('@/agentDocker/materializer');
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
      tools: { mcpServers: ['aha'], skills: [] as string[] },
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
      });

      const spawnBody = {
        directory: plan.effectiveCwd,
        agent: opts.model === 'codex' ? 'codex' : 'claude',
        role: roleId,
        sessionName: name,
        teamId,
        env: materializedEnv,
      };

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
