import chalk from 'chalk';
import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { readCredentials } from '@/persistence';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { materializeAgentWorkspace, type AgentDockerConfig } from '@/agentDocker/materializer';
import { buildMaterializedSpawnEnv } from '@/agentDocker/runtimeConfig';
import { isRecognizedModelId } from '@/utils/modelContextWindows';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'node:crypto';
import { ensureDaemonRunning } from '@/daemon/controlClient';
import { readDaemonState } from '@/persistence';

type AgentUpdateOptions = {
  name?: string;
  role?: string;
  teamId?: string;
  clearTeam?: boolean;
  sessionTag?: string;
  summary?: string;
  path?: string;
  model?: string;
  fallbackModel?: string;
};

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
  const booleanFlags = new Set(['--json', '--force', '-f', '--verbose', '-v', '--active', '--clear-team', '--help', '-h']);

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

function sanitizeSession(session: any): any {
  const { encryptionKey, encryptionVariant, ...rest } = session;
  return rest;
}

function getSessionDisplayName(session: any): string {
  const metadata = session.metadata || {};
  return metadata.name || metadata.sessionTag || metadata.claudeSessionId || session.id;
}

function printSession(session: any, verbose = false): void {
  const metadata = session.metadata || {};
  const role = metadata.role || 'agent';
  const teamId = metadata.teamId || '-';
  const path = metadata.path || '-';
  const state = session.active ? chalk.green('active') : chalk.gray('archived');

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
}

function collectSessionIds(args: string[], positional: string[]): string[] {
  const idsFromFlag = parseCsvOption(args, 'ids');
  if (idsFromFlag && idsFromFlag.length > 0) {
    return idsFromFlag;
  }

  return positional.slice(1).map(value => value.trim()).filter(Boolean);
}

function buildUpdateOptions(args: string[]): AgentUpdateOptions {
  return {
    name: getOption(args, 'name'),
    role: getOption(args, 'role'),
    teamId: getOption(args, 'team'),
    clearTeam: hasFlag(args, '--clear-team'),
    sessionTag: getOption(args, 'session-tag'),
    summary: getOption(args, 'summary'),
    path: getOption(args, 'path') || getOption(args, 'cwd'),
    model: getOption(args, 'model'),
    fallbackModel: getOption(args, 'fallback-model'),
  };
}

export function applyMetadataUpdates(existingMetadata: any, updates: AgentUpdateOptions): any {
  const nextMetadata = { ...existingMetadata };
  let changed = false;

  if (updates.name !== undefined) {
    nextMetadata.name = updates.name;
    changed = true;
  }

  if (updates.role !== undefined) {
    nextMetadata.role = updates.role;
    changed = true;
  }

  if (updates.teamId !== undefined) {
    nextMetadata.teamId = updates.teamId;
    changed = true;
  }

  if (updates.clearTeam) {
    delete nextMetadata.teamId;
    delete nextMetadata.roomId;
    delete nextMetadata.roomName;
    changed = true;
  }

  if (updates.sessionTag !== undefined) {
    nextMetadata.sessionTag = updates.sessionTag;
    changed = true;
  }

  if (updates.summary !== undefined) {
    nextMetadata.summary = {
      text: updates.summary,
      updatedAt: Date.now(),
    };
    changed = true;
  }

  if (updates.path !== undefined) {
    nextMetadata.path = updates.path;
    changed = true;
  }

  if (updates.model !== undefined) {
    if (!isRecognizedModelId(updates.model)) {
      throw new Error(
        `Unknown model ID: "${updates.model}". Must be a recognized Claude model (e.g. claude-opus-4-5, claude-sonnet-4-5).`
      );
    }
    nextMetadata.modelOverride = updates.model;
    changed = true;
  }

  if (updates.fallbackModel !== undefined) {
    if (!isRecognizedModelId(updates.fallbackModel)) {
      throw new Error(
        `Unknown fallback model ID: "${updates.fallbackModel}". Must be a recognized Claude model.`
      );
    }
    nextMetadata.fallbackModelOverride = updates.fallbackModel;
    changed = true;
  }

  if (!changed) {
    throw new Error('No updates provided. Pass at least one of --name, --role, --team, --clear-team, --session-tag, --summary, --path, --model, or --fallback-model.');
  }

  return nextMetadata;
}

export function showAgentsHelp(): void {
  console.log(`
${chalk.bold.cyan('Aha Agents')} - Session-backed agent management commands

${chalk.bold('Usage:')}
  ${chalk.green('aha agents')} <command> [options]

${chalk.bold('Commands:')}
  ${chalk.yellow('list')}                          List agent sessions
  ${chalk.yellow('show')} <sessionId>              Show one agent session
  ${chalk.yellow('update')} <sessionId>            Update decrypted session metadata
  ${chalk.yellow('rename')} <sessionId> <name>     Rename an agent (metadata.name)
  ${chalk.yellow('archive')} <id...>               Archive one or more agent sessions
  ${chalk.yellow('delete')} <id...>                Delete one or more agent sessions
  ${chalk.yellow('spawn')} <agent.json>            Spawn agent from local agent JSON file

${chalk.bold('List options:')}
  ${chalk.cyan('--active')}                       Only show active sessions
  ${chalk.cyan('--team <teamId>')}                Filter by metadata.teamId
  ${chalk.cyan('--role <roleId>')}                Filter by metadata.role
  ${chalk.cyan('--json')}                         Print raw JSON output
  ${chalk.cyan('--verbose, -v')}                  Show extra metadata fields

${chalk.bold('Update options:')}
  ${chalk.cyan('--name <text>')}                  Set metadata.name
  ${chalk.cyan('--role <roleId>')}                Set metadata.role
  ${chalk.cyan('--team <teamId>')}                Set metadata.teamId
  ${chalk.cyan('--clear-team')}                   Remove metadata.teamId / room fields
  ${chalk.cyan('--session-tag <tag>')}            Set metadata.sessionTag
  ${chalk.cyan('--summary <text>')}               Set metadata.summary.text
  ${chalk.cyan('--path <cwd>')}                   Set metadata.path
  ${chalk.cyan('--model <modelId>')}              Override the agent's model (e.g. claude-opus-4-5)
  ${chalk.cyan('--fallback-model <modelId>')}     Override the agent's fallback model

${chalk.bold('Workflow options:')}
  ${chalk.cyan('--ids a,b,c')}                    Alternative to positional IDs for archive/delete
  ${chalk.cyan('--force, -f')}                    Skip archive/delete confirmation

${chalk.bold('Spawn options:')}
  ${chalk.cyan('--team <teamId>')}                Register spawned agent in this team
  ${chalk.cyan('--role <roleId>')}                Role label for team registration (default: agent name)
  ${chalk.cyan('--path <cwd>')}                   Working directory for the agent (default: current dir)

${chalk.bold('Examples:')}
  ${chalk.green('aha agents list --active --team team_123')}
  ${chalk.green('aha agents show session_123')}
  ${chalk.green('aha agents update session_123 --role builder --team team_123')}
  ${chalk.green('aha agents rename session_123 "Builder 2"')}
  ${chalk.green('aha agents archive session_123 session_456')}
  ${chalk.green('aha agents spawn examples/agent-json/builder.agent.json --team team_123 --role builder')}
`);
}

export async function handleAgentsCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    showAgentsHelp();
    return;
  }

  const api = await createApiClient();
  const positional = getPositionalArgs(args);
  const asJson = hasFlag(args, '--json');
  const verbose = hasFlag(args, '--verbose', '-v');

  try {
    switch (subcommand) {
      case 'list':
        await listAgents(api, {
          asJson,
          verbose,
          activeOnly: hasFlag(args, '--active'),
          teamId: getOption(args, 'team'),
          role: getOption(args, 'role'),
        });
        break;
      case 'show':
        if (positional.length < 2) {
          throw new Error('Usage: aha agents show <sessionId>');
        }
        await showAgent(api, positional[1], asJson, verbose);
        break;
      case 'update':
        if (positional.length < 2) {
          throw new Error('Usage: aha agents update <sessionId> [fields...]');
        }
        await updateAgent(api, positional[1], buildUpdateOptions(args), asJson, verbose);
        break;
      case 'rename': {
        if (positional.length < 3) {
          throw new Error('Usage: aha agents rename <sessionId> <name>');
        }
        const sessionId = positional[1];
        const name = positional.slice(2).join(' ');
        await updateAgent(api, sessionId, { name }, asJson, verbose);
        break;
      }
      case 'archive': {
        const sessionIds = collectSessionIds(args, positional);
        if (sessionIds.length === 0) {
          throw new Error('Usage: aha agents archive <sessionId...> [--ids a,b,c]');
        }
        await archiveAgents(api, sessionIds, hasFlag(args, '--force', '-f'), asJson);
        break;
      }
      case 'delete': {
        const sessionIds = collectSessionIds(args, positional);
        if (sessionIds.length === 0) {
          throw new Error('Usage: aha agents delete <sessionId...> [--ids a,b,c]');
        }
        await deleteAgents(api, sessionIds, hasFlag(args, '--force', '-f'), asJson);
        break;
      }
      case 'spawn': {
        if (positional.length < 2) {
          throw new Error('Usage: aha agents spawn <agent.json> [--team <teamId>] [--role <role>] [--path <cwd>]');
        }
        await spawnAgent(api, positional[1], {
          teamId: getOption(args, 'team'),
          role: getOption(args, 'role'),
          cwd: getOption(args, 'path') || getOption(args, 'cwd') || process.cwd(),
          asJson,
        });
        break;
      }
      default:
        throw new Error(`Unknown agents command: ${subcommand}`);
    }
  } catch (error) {
    logger.debug('[AgentsCommand] Error:', error);
    console.log(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}

async function listAgents(
  api: ApiClient,
  opts: { asJson: boolean; verbose: boolean; activeOnly: boolean; teamId?: string; role?: string },
): Promise<void> {
  const result = await api.listSessions();
  const filteredSessions = result.sessions.filter((session: any) => {
    const metadata = session.metadata || {};
    if (opts.activeOnly && !session.active) {
      return false;
    }
    if (opts.teamId && metadata.teamId !== opts.teamId) {
      return false;
    }
    if (opts.role && metadata.role !== opts.role) {
      return false;
    }
    return true;
  });

  if (opts.asJson) {
    console.log(JSON.stringify({ sessions: filteredSessions.map(sanitizeSession) }, null, 2));
    return;
  }

  if (!filteredSessions.length) {
    console.log(chalk.yellow('No agent sessions found.'));
    return;
  }

  console.log(chalk.bold(`\nAgent sessions (${filteredSessions.length})\n`));
  for (const session of filteredSessions) {
    printSession(session, opts.verbose);
  }
  console.log();
}

async function showAgent(api: ApiClient, sessionId: string, asJson: boolean, verbose: boolean): Promise<void> {
  const session = await api.getSession(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  if (asJson) {
    console.log(JSON.stringify(sanitizeSession(session), null, 2));
    return;
  }

  console.log(chalk.bold(`\nAgent session ${sessionId}\n`));
  printSession(session, true);
  console.log();
}

async function updateAgent(
  api: ApiClient,
  sessionId: string,
  updates: AgentUpdateOptions,
  asJson: boolean,
  verbose: boolean,
): Promise<void> {
  const session = await api.getSession(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }
  if (!session.isDecrypted || !session.metadata) {
    throw new Error('Session metadata could not be decrypted; refusing to patch opaque data.');
  }

  const nextMetadata = applyMetadataUpdates(session.metadata, updates);
  const result = await api.updateSessionMetadata(sessionId, nextMetadata, session.metadataVersion);

  if (asJson) {
    console.log(JSON.stringify(sanitizeSession(result.session), null, 2));
    return;
  }

  console.log(chalk.green(`✓ Agent ${sessionId} updated successfully`));
  printSession(result.session, verbose);
  console.log();
}

async function archiveAgents(api: ApiClient, sessionIds: string[], force: boolean, asJson: boolean): Promise<void> {
  if (!force) {
    const confirmed = await confirm(`Archive ${sessionIds.length} agent session(s)? (y/N): `);
    if (!confirmed) {
      console.log(chalk.yellow('Operation cancelled'));
      return;
    }
  }

  const result = await api.batchArchiveSessions(sessionIds);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.green(`✓ Archived ${result.archived} agent session(s)`));
  if (result.results.some((entry: any) => !entry.success)) {
    for (const entry of result.results) {
      const color = entry.success ? chalk.green : chalk.red;
      console.log(color(`  - ${entry.sessionId}: ${entry.success ? 'ok' : entry.error || 'failed'}`));
    }
  }
  console.log();
}

async function deleteAgents(api: ApiClient, sessionIds: string[], force: boolean, asJson: boolean): Promise<void> {
  if (!force) {
    const confirmed = await confirm(`Delete ${sessionIds.length} agent session(s)? (y/N): `);
    if (!confirmed) {
      console.log(chalk.yellow('Operation cancelled'));
      return;
    }
  }

  if (sessionIds.length === 1) {
    const result = await api.deleteSession(sessionIds[0]);
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(chalk.green(`✓ Deleted agent session ${sessionIds[0]}`));
    console.log();
    return;
  }

  const result = await api.batchDeleteSessions(sessionIds);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.green(`✓ Deleted ${result.deleted} agent session(s)`));
  if (result.results.some((entry: any) => !entry.success)) {
    for (const entry of result.results) {
      const color = entry.success ? chalk.green : chalk.red;
      console.log(color(`  - ${entry.sessionId}: ${entry.success ? 'ok' : entry.error || 'failed'}`));
    }
  }
  console.log();
}

async function spawnAgent(
  api: ApiClient,
  filePath: string,
  opts: { teamId?: string; role?: string; cwd?: string; asJson: boolean },
): Promise<void> {
  const resolvedPath = resolve(filePath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Agent JSON file not found: ${resolvedPath}`);
  }

  let config: AgentDockerConfig;
  try {
    const raw = JSON.parse(readFileSync(resolvedPath, 'utf-8'));
    if (raw.kind !== 'aha.agent.v1') {
      throw new Error(`Invalid agent JSON: expected kind "aha.agent.v1", got "${raw.kind}"`);
    }
    config = raw as AgentDockerConfig;
  } catch (err) {
    throw new Error(`Failed to parse agent JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const agentId = randomUUID();
  const repoRoot = opts.cwd || process.cwd();

  if (!opts.asJson) {
    console.log(chalk.bold(`\nMaterializing workspace for agent: ${config.name}\n`));
  }

  const plan = materializeAgentWorkspace({
    agentId,
    repoRoot,
    runtime: config.runtime,
    config,
    workspaceMode: config.workspace?.defaultMode,
  });

  if (!opts.asJson) {
    console.log(chalk.gray(`  workspaceRoot: ${plan.workspaceRoot}`));
    console.log(chalk.gray(`  settingsPath:  ${plan.settingsPath}`));
    console.log(chalk.gray(`  effectiveCwd:  ${plan.effectiveCwd}`));
    if (plan.warnings.length > 0) {
      for (const w of plan.warnings) {
        console.log(chalk.yellow(`  ⚠ ${w}`));
      }
    }
    console.log();
  }

  await ensureDaemonRunning();
  const daemonState = await readDaemonState();
  if (!daemonState?.httpPort) {
    throw new Error('Daemon is not running. Start it with: aha');
  }

  const role = opts.role || config.name;
  const materializedEnv = buildMaterializedSpawnEnv({
    settingsPath: plan.settingsPath,
    envFilePath: plan.envFilePath,
    mcpConfigPath: plan.mcpConfigPath,
  });
  const spawnBody = {
    directory: plan.effectiveCwd,
    agent: config.runtime === 'codex' ? 'codex' : 'claude',
    role,
    sessionName: config.name,
    teamId: opts.teamId,
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
    throw new Error(`Daemon spawn failed: ${result.error || `HTTP ${response.status}`}`);
  }

  const sessionId = result.sessionId!;

  if (opts.teamId && sessionId) {
    try {
      await api.addTeamMember(opts.teamId, sessionId, role, config.name, {
        executionPlane: 'mainline',
        runtimeType: config.runtime === 'codex' ? 'codex' : 'claude',
      });
    } catch (err) {
      logger.debug('[agents spawn] Warning: failed to register in team roster:', err);
    }
  }

  if (opts.asJson) {
    console.log(JSON.stringify({ sessionId, agentId, settingsPath: plan.settingsPath, role, teamId: opts.teamId }, null, 2));
    return;
  }

  console.log(chalk.green(`✓ Agent spawned: ${sessionId}`));
  console.log(chalk.gray(`  role=${role} runtime=${config.runtime} teamId=${opts.teamId || '-'}`));
  console.log(chalk.gray(`  settings=${plan.settingsPath}`));
  console.log();
}
