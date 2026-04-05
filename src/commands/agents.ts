import chalk from 'chalk';
import { ApiClient } from '@/api/api';
import { decrypt, decodeBase64 } from '@/api/encryption';
import type { AgentImage } from '@/api/types/genome';
import { logger } from '@/ui/logger';
import { readCredentials } from '@/persistence';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import {
  buildAgentWorkspacePlanFromAgentImage,
  materializeAgentWorkspace,
  type AgentDockerConfig,
  withDefaultAgentSkills,
} from '@/agentDocker/materializer';
import { buildMaterializedSpawnEnv } from '@/agentDocker/runtimeConfig';
import { fetchAgentImage } from '@/claude/utils/fetchGenome';
import { isRecognizedModelId } from '@/utils/modelContextWindows';
import { publishTeamCorpsTemplate, resolvePreferredGenomeSpecId } from '@/utils/genomeMarketplace';
import { normalizeAgentImageForPublication } from '@/utils/genomePublication';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'node:crypto';
import { ensureDaemonRunning, checkIfDaemonRunningAndCleanupStaleState, daemonPost } from '@/daemon/controlClient';
import { readDaemonState } from '@/persistence';
import { COORDINATION_ROLES } from '@/claude/team/roleConstants';
import { findClaudeLogFile } from '@/claude/utils/runtimeLogReader';
import { homedir } from 'os';
import { confirmPrompt, getCliCommandExitCode, printCliCommandError, printCliDryRunPreview } from './globalCli';

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
  const booleanFlags = new Set(['--json', '--force', '-f', '--verbose', '-v', '--active', '--clear-team', '--help', '-h', '--dry-run']);

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
        `Unknown model ID: "${updates.model}". Must be a recognized Claude model (e.g. claude-opus-4-6, claude-sonnet-4-6).`
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
  ${chalk.green('aha agent')} <command> [options]

${chalk.bold('Commands:')}
  ${chalk.yellow('list')}                          List agent sessions
  ${chalk.yellow('show')} <sessionId>              Show one agent session
  ${chalk.yellow('create')}                        Create and spawn an agent by role
  ${chalk.yellow('update')} <sessionId>            Update decrypted session metadata
  ${chalk.yellow('rename')} <sessionId> <name>     Rename an agent (metadata.name)
  ${chalk.yellow('archive')} <id...>               Archive one or more agent sessions
  ${chalk.yellow('unarchive')} <id...>             Restore one or more archived agent sessions
  ${chalk.yellow('delete')} <id...>                Delete one or more agent sessions
  ${chalk.yellow('kill')} <sessionId...>           Kill (archive) one or more agents
  ${chalk.yellow('logs')} <sessionId>              Show agent CC log (last N entries)
  ${chalk.yellow('spawn')} <agent.json>            Spawn agent from local agent JSON file

${chalk.bold('List options:')}
  ${chalk.cyan('--active')}                       Only show active sessions
  ${chalk.cyan('--team <teamId>')}                Filter by metadata.teamId
  ${chalk.cyan('--role <roleId>')}                Filter by metadata.role
  ${chalk.cyan('--json')}                         Print raw JSON output
  ${chalk.cyan('--format <json|table>')}         Select JSON or human output mode
  ${chalk.cyan('--verbose, -v')}                  Show extra metadata fields

${chalk.bold('Update options:')}
  ${chalk.cyan('--name <text>')}                  Set metadata.name
  ${chalk.cyan('--role <roleId>')}                Set metadata.role
  ${chalk.cyan('--team <teamId>')}                Set metadata.teamId
  ${chalk.cyan('--clear-team')}                   Remove metadata.teamId / room fields
  ${chalk.cyan('--session-tag <tag>')}            Set metadata.sessionTag
  ${chalk.cyan('--summary <text>')}               Set metadata.summary.text
  ${chalk.cyan('--path <cwd>')}                   Set metadata.path
  ${chalk.cyan('--model <modelId>')}              Override the agent's model (e.g. claude-opus-4-6)
  ${chalk.cyan('--fallback-model <modelId>')}     Override the agent's fallback model

${chalk.bold('Logs options:')}
  ${chalk.cyan('--lines <n>')}                   Number of log entries to show (default: 50)
  ${chalk.cyan('--verbose, -v')}                  Show full entry detail

${chalk.bold('Workflow options:')}
  ${chalk.cyan('--ids a,b,c')}                    Alternative to positional IDs for archive/delete
  ${chalk.cyan('--force, -f')}                    Skip archive/delete confirmation
  ${chalk.cyan('--dry-run')}                      Preview archive/delete/unarchive without mutating the server
  ${chalk.cyan('--no-interactive')}               Fail instead of prompting; pair with --force for agents

${chalk.bold('Create options (P0):')}
  ${chalk.cyan('--role <roleId>')}                Role to create (builder|qa-engineer|master|implementer|researcher|...)
  ${chalk.cyan('--team <teamId>')}                Register agent in this team (auto-injects teamId in prompt)
  ${chalk.cyan('--name <displayName>')}           Display name for the agent (default: role name)
  ${chalk.cyan('--model claude|codex')}           Runtime model (default: claude)
  ${chalk.cyan('--path <cwd>')}                   Working directory (default: current dir)

${chalk.bold('Spawn options:')}
  ${chalk.cyan('--team <teamId>')}                Register spawned agent in this team
  ${chalk.cyan('--role <roleId>')}                Role label for team registration (default: agent name)
  ${chalk.cyan('--path <cwd>')}                   Working directory for the agent (default: current dir)

${chalk.bold('Examples:')}
  ${chalk.green('aha agents list --active --team team_123')}
  ${chalk.green('aha agents show session_123')}
  ${chalk.green('aha agents create --role builder --team team_123')}
  ${chalk.green('aha agents create --role qa-engineer --team team_123 --name "QA Bot"')}
  ${chalk.green('aha agents kill session_123')}
  ${chalk.green('aha agents logs session_123')}
  ${chalk.green('aha agents logs session_123 --lines 100')}
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
  const dryRun = hasFlag(args, '--dry-run');

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
      case 'create': {
        const roleId = getOption(args, 'role');
        if (!roleId) {
          throw new Error('Usage: aha agents create --role <roleId> [--team <teamId>] [--name <name>] [--model claude|codex]');
        }
        await createAgent(api, roleId, {
          teamId: getOption(args, 'team'),
          name: getOption(args, 'name'),
          model: (getOption(args, 'model') || 'claude') as 'claude' | 'codex',
          cwd: getOption(args, 'path') || getOption(args, 'cwd') || process.cwd(),
          asJson,
        });
        break;
      }
      case 'kill': {
        const sessionIds = collectSessionIds(args, positional);
        if (sessionIds.length === 0) {
          throw new Error('Usage: aha agents kill <sessionId...>');
        }
        await archiveAgents(api, sessionIds, true, asJson, dryRun);
        break;
      }
      case 'logs': {
        if (positional.length < 2) {
          throw new Error('Usage: aha agents logs <sessionId> [--lines N]');
        }
        const lines = parseInt(getOption(args, 'lines') || '50', 10);
        await logsAgent(api, positional[1], { lines: isFinite(lines) && lines > 0 ? lines : 50, asJson, verbose });
        break;
      }
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
        await archiveAgents(api, sessionIds, hasFlag(args, '--force', '-f'), asJson, dryRun);
        break;
      }
      case 'unarchive': {
        const sessionIds = collectSessionIds(args, positional);
        if (sessionIds.length === 0) {
          throw new Error('Usage: aha agents unarchive <sessionId...> [--ids a,b,c]');
        }
        await unarchiveAgents(api, sessionIds, hasFlag(args, '--force', '-f'), asJson, dryRun);
        break;
      }
      case 'delete': {
        const sessionIds = collectSessionIds(args, positional);
        if (sessionIds.length === 0) {
          throw new Error('Usage: aha agents delete <sessionId...> [--ids a,b,c]');
        }
        await deleteAgents(api, sessionIds, hasFlag(args, '--force', '-f'), asJson, dryRun);
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
      case 'messages': {
        if (positional.length < 2) {
          throw new Error('Usage: aha agents messages <sessionId> [--limit N]');
        }
        const limit = parseInt(getOption(args, 'limit') || '20', 10);
        await showAgentMessages(api, positional[1], { limit: isFinite(limit) && limit > 0 ? limit : 20, asJson, verbose });
        break;
      }
      case 'send': {
        if (positional.length < 2) {
          throw new Error('Usage: aha agents send <sessionId> "<message>"');
        }
        const content = positional.slice(2).join(' ');
        if (!content) {
          throw new Error('Message content is required');
        }
        await sendAgentMessage(positional[1], content, asJson);
        break;
      }
      default:
        throw new Error(`Unknown agents command: ${subcommand}`);
    }
  } catch (error) {
    logger.debug('[AgentsCommand] Error:', error);
    printCliCommandError(error);
    process.exit(getCliCommandExitCode(error));
  }
}

// ─── agents messages ──────────────────────────────────────────────────────────

function extractTextFromContent(msgContent: any, fallback: any): string {
  if (typeof msgContent === 'string') return msgContent;
  if (Array.isArray(msgContent)) {
    return msgContent.map((c: any) => {
      if (typeof c === 'string') return c;
      if (c?.type === 'text') return c.text ?? '';
      if (c?.type === 'tool_use') return `[tool:${c.name}(${JSON.stringify(c.input ?? {}).slice(0, 60)})]`;
      if (c?.type === 'tool_result') return `[→${JSON.stringify(c.content ?? '').slice(0, 80)}]`;
      if (c?.type === 'thinking') return `[think:${(c.thinking ?? '').slice(0, 50)}…]`;
      return JSON.stringify(c).slice(0, 60);
    }).filter(Boolean).join(' ');
  }
  if (msgContent && typeof msgContent === 'object') {
    // Might be another nested JSONL entry
    return extractTextFromContent(msgContent?.message?.content ?? msgContent?.content, null) || JSON.stringify(msgContent).slice(0, 120);
  }
  return fallback ? JSON.stringify(fallback).slice(0, 120) : '';
}

async function showAgentMessages(
  api: ApiClient,
  sessionId: string,
  options: { limit: number; asJson?: boolean; verbose?: boolean },
): Promise<void> {
  // Fetch session to get encryption key
  const session = await api.getSession(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  const result = await api.getSessionMessages(sessionId, { limit: options.limit });
  const rawMessages = result.messages ?? [];

  // Session messages come back newest-first; reverse to chronological (oldest at top, newest at bottom)
  const sorted = [...rawMessages].sort((a: any, b: any) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

  const messages: Array<{ role: string; content: string; timestamp?: number }> = sorted.map((raw: any) => {
    // Session messages: {id, seq, content: {c: '...', t: '...'}, createdAt, updatedAt}
    const blob = raw.content ?? raw.text ?? '';
    if (session.isDecrypted && session.encryptionKey && typeof blob === 'object' && blob?.c) {
      try {
        const decoded = decodeBase64(blob.c);
        const decrypted = decrypt(session.encryptionKey, session.encryptionVariant, decoded);
        if (!decrypted || typeof decrypted !== 'object') {
          return { role: 'encrypted', content: '[decrypt failed]', timestamp: raw.createdAt ?? raw.timestamp };
        }

        // Envelope: {role:'agent'|'user', content: <inner>, meta?}
        // Inner can be the Claude JSONL entry: {type, message:{role, content:[...]}}
        // OR inner IS the Claude JSONL entry directly.
        const envelope: any = decrypted;
        const outerRole: string = envelope?.role ?? 'agent';
        const inner: any = envelope?.content ?? envelope;

        // Resolve actual message role and content
        const msgRole: string = inner?.message?.role ?? inner?.role ?? outerRole;
        const msgContent: any = inner?.message?.content ?? inner?.content;

        const text = extractTextFromContent(msgContent, inner);
        return { role: msgRole, content: text.slice(0, 600), timestamp: raw.createdAt ?? raw.timestamp };
      } catch {
        return { role: 'encrypted', content: '[decrypt failed]', timestamp: raw.createdAt ?? raw.timestamp };
      }
    }
    // Plaintext (team broadcast, etc.)
    const role = raw.role ?? raw.senderRole ?? 'system';
    const content = typeof blob === 'object' ? JSON.stringify(blob).slice(0, 300) : String(blob).slice(0, 600);
    return { role, content, timestamp: raw.createdAt ?? raw.timestamp };
  });

  if (options.asJson) {
    console.log(JSON.stringify({ sessionId, messages }, null, 2));
    return;
  }

  if (messages.length === 0) {
    console.log(chalk.yellow('No messages found'));
    return;
  }

  console.log(chalk.bold(`\nAgent messages for ${sessionId} (${messages.length}):\n`));
  for (const msg of messages) {
    const roleColor = msg.role === 'user' ? chalk.green : msg.role === 'assistant' ? chalk.cyan : chalk.gray;
    const ts = msg.timestamp ? chalk.gray(new Date(msg.timestamp).toLocaleTimeString() + ' ') : '';
    console.log(`${ts}${roleColor(`[${msg.role}]`)} ${msg.content}`);
    if (options.verbose) {
      console.log('');
    }
  }
}

// ─── agents send ──────────────────────────────────────────────────────────────

async function sendAgentMessage(sessionId: string, message: string, asJson?: boolean): Promise<void> {
  const result = await daemonPost('/session-command', { sessionId, command: message });

  if (result?.error) {
    // stdin may be closed for daemon-external sessions — surface a clear hint
    const hint = result.error.includes('no writable stdin') || result.error.includes('not tracked')
      ? `\n  Hint: use "aha teams send <teamId> \\"@<role> ${message}\\"" to broadcast via team chat instead`
      : '';
    throw new Error(`${result.error}${hint}`);
  }

  if (asJson) {
    console.log(JSON.stringify({ success: true, sessionId, message }, null, 2));
    return;
  }
  console.log(chalk.green(`✓ Message sent to agent ${sessionId}`));
  console.log(chalk.gray('  (injected into agent stdin — agent will process it as user input)'));
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

async function archiveAgents(api: ApiClient, sessionIds: string[], force: boolean, asJson: boolean, dryRun: boolean): Promise<void> {
  if (dryRun) {
    printCliDryRunPreview(
      {
        action: 'agents.archive',
        summary: `Would archive ${sessionIds.length} agent session(s).`,
        target: { sessionIds },
      },
      { asJson },
    );
    return;
  }

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

async function unarchiveAgents(api: ApiClient, sessionIds: string[], force: boolean, asJson: boolean, dryRun: boolean): Promise<void> {
  if (dryRun) {
    printCliDryRunPreview(
      {
        action: 'agents.unarchive',
        summary: `Would restore ${sessionIds.length} agent session(s).`,
        target: { sessionIds },
      },
      { asJson },
    );
    return;
  }

  if (!force) {
    const confirmed = await confirm(`Restore ${sessionIds.length} agent session(s)? (y/N): `);
    if (!confirmed) {
      console.log(chalk.yellow('Operation cancelled'));
      return;
    }
  }

  const result = await api.batchUnarchiveSessions(sessionIds);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(chalk.green(`✓ Restored ${result.restored} agent session(s)`));
  if (result.results.some((entry: any) => !entry.success)) {
    for (const entry of result.results) {
      const color = entry.success ? chalk.green : chalk.red;
      console.log(color(`  - ${entry.sessionId}: ${entry.success ? 'ok' : entry.error || 'failed'}`));
    }
  }
  console.log();
}

async function deleteAgents(api: ApiClient, sessionIds: string[], force: boolean, asJson: boolean, dryRun: boolean): Promise<void> {
  if (dryRun) {
    printCliDryRunPreview(
      {
        action: 'agents.delete',
        summary: `Would delete ${sessionIds.length} agent session(s).`,
        target: { sessionIds },
      },
      { asJson },
    );
    return;
  }

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

/** Built-in role configs for `aha agent create --role <roleId>` */
const BUILTIN_ROLE_CONFIGS: Record<string, Partial<AgentDockerConfig>> = {
  builder: {
    description: 'Code builder — implements tasks and drives them to completion',
    systemPromptSuffix: 'Implement assigned tasks. Keep diffs small. Report blockers immediately.',
    behavior: { onIdle: 'self-assign', onBlocked: 'report', canSpawnAgents: false, requireExplicitAssignment: false, onRetire: 'write-handoff', onContextHigh: 'compact' },
  },
  'qa-engineer': {
    description: 'Quality assurance engineer — tests features and validates functionality',
    systemPromptSuffix: 'Run tests, verify acceptance criteria, report bugs with repro steps.',
    behavior: { onIdle: 'self-assign', onBlocked: 'report', canSpawnAgents: false, requireExplicitAssignment: false, onContextHigh: 'compact' },
  },
  master: {
    description: 'Master coordinator — shapes delivery plan and keeps Kanban accurate',
    systemPromptSuffix: 'Translate goals into Kanban tasks. Sequence work, surface blockers, coordinate the team.',
    // canSpawnAgents: true — master is a coordinator role and must be able to spawn agents via create_agent.
    // Old templates had canSpawnAgents: false here, which incorrectly blocked agent topology management.
    behavior: { onIdle: 'self-assign', onBlocked: 'report', canSpawnAgents: true, requireExplicitAssignment: false, onContextHigh: 'summarize' },
  },
  implementer: {
    description: 'Implementer — executes implementation tasks end-to-end',
    systemPromptSuffix: 'Implement the assigned task fully. Signal when ready for review.',
    behavior: { onIdle: 'self-assign', onBlocked: 'report', canSpawnAgents: false, requireExplicitAssignment: false, onRetire: 'write-handoff', onContextHigh: 'compact' },
  },
  researcher: {
    description: 'Researcher — explores codebase, gathers information, provides context',
    systemPromptSuffix: 'Search and analyze code. Present findings with file citations. Read-only.',
    behavior: { onIdle: 'self-assign', onBlocked: 'report', canSpawnAgents: false, requireExplicitAssignment: false, onContextHigh: 'summarize' },
  },
  'devops-builder': {
    description: 'DevOps builder — handles SSH deployment, CI/CD, infrastructure',
    systemPromptSuffix: 'Handle server deployments, SSH operations, nginx config, PM2 management.',
    behavior: { onIdle: 'self-assign', onBlocked: 'report', canSpawnAgents: false, requireExplicitAssignment: false, onRetire: 'write-handoff', onContextHigh: 'compact' },
  },
};

type BuiltinAgentImageOptions = {
  roleId: string;
  displayName: string;
  runtime: 'claude' | 'codex';
  teamId?: string;
};

export function buildBuiltinAgentImage(
  options: BuiltinAgentImageOptions,
): { agentImage: AgentImage; promptSuffix?: string } {
  const roleConfig = BUILTIN_ROLE_CONFIGS[options.roleId] || {};
  const teamContextSuffix = options.teamId
    ? `## Team Context
- Team ID: ${options.teamId}
- Your role: ${options.roleId}
- On startup: call get_team_info then list_tasks
- Kanban protocol: start_task before work, complete_task after done
- Report blockers via send_team_message @master`
    : '';
  const promptSuffix = [roleConfig.systemPromptSuffix, teamContextSuffix]
    .map(value => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join('\n\n') || undefined;
  const authorities = [
    ...(COORDINATION_ROLES.includes(options.roleId) ? ['task.create'] : []),
    ...(roleConfig.behavior?.canSpawnAgents ? ['agent.spawn'] : []),
  ];
  const canonicalSpec = {
    kind: 'aha.agent.v1' as const,
    name: options.displayName,
    description: roleConfig.description || `${options.roleId} agent`,
    baseRoleId: options.roleId,
    runtime: options.runtime,
    ...(promptSuffix ? { prompt: { suffix: promptSuffix } } : {}),
    tools: {
      mcpServers: ['aha'],
      skills: withDefaultAgentSkills(),
    },
    context: {
      teamRole: options.roleId,
      ...(authorities.length > 0 ? { authorities } : {}),
      behavior: roleConfig.behavior,
    },
    env: {
      required: ['ANTHROPIC_API_KEY'],
      optional: ['AHA_ROOM_ID', 'AHA_SESSION_ID'],
    },
    workspace: {
      defaultMode: 'shared' as const,
      allowedModes: ['shared' as const, 'isolated' as const],
    },
  };

  const normalized = normalizeAgentImageForPublication({
    specJson: JSON.stringify(canonicalSpec),
    runtimeLibRoot: null,
  });

  return {
    agentImage: normalized.spec as AgentImage,
    promptSuffix,
  };
}

export async function resolveMaterializedAgentImageForCreate(options: {
  builtinAgentImage: AgentImage;
  specId?: string | null;
  authToken?: string | null;
}): Promise<AgentImage> {
  if (!options.specId) {
    return options.builtinAgentImage;
  }

  const authToken = options.authToken?.trim();
  if (!authToken) {
    throw new Error(`Cannot materialize published agent image ${options.specId}: missing auth token.`);
  }

  const publishedAgentImage = await fetchAgentImage(authToken, options.specId);
  if (!publishedAgentImage) {
    throw new Error(`Resolved published agent image ${options.specId} was not found in genome-hub.`);
  }

  return publishedAgentImage;
}

async function createAgent(
  api: ApiClient,
  roleId: string,
  opts: { teamId?: string; name?: string; model: 'claude' | 'codex'; cwd?: string; asJson: boolean },
): Promise<void> {
  const agentId = randomUUID();
  const repoRoot = opts.cwd || process.cwd();
  const displayName = opts.name || roleId;
  const built = buildBuiltinAgentImage({
    roleId,
    displayName,
    runtime: opts.model,
    teamId: opts.teamId,
  });

  if (!opts.asJson) {
    console.log(chalk.bold(`\nCreating agent: ${displayName} (${roleId})\n`));
  }

  const specResolution = await resolvePreferredGenomeSpecId({
    role: roleId,
    runtime: opts.model,
    strategy: 'best-rated',
  });

  const credentials = await readCredentials();
  const materializedAgentImage = await resolveMaterializedAgentImageForCreate({
    builtinAgentImage: built.agentImage,
    specId: specResolution.specId,
    authToken: credentials?.token,
  });

  const plan = buildAgentWorkspacePlanFromAgentImage(materializedAgentImage, {
    agentId,
    repoRoot,
    specId: specResolution.specId ?? undefined,
    workspaceMode: 'shared',
  });

  if (!opts.asJson && plan.warnings.length > 0) {
    for (const w of plan.warnings) {
      console.log(chalk.yellow(`  ⚠ ${w}`));
    }
  }

  await ensureDaemonRunning();
  const daemonState = await readDaemonState();
  if (!daemonState?.httpPort) {
    throw new Error('Daemon is not running. Start it with: aha');
  }

  const materializedEnv = buildMaterializedSpawnEnv({
    settingsPath: plan.settingsPath,
    envFilePath: plan.envFilePath,
    mcpConfigPath: plan.mcpConfigPath,
    commandsDir: plan.commandsDir,
  });
  if (!specResolution.specId && built.promptSuffix) {
    materializedEnv.AHA_AGENT_PROMPT = built.promptSuffix;
  }

  const spawnBody = {
    directory: plan.effectiveCwd,
    agent: materializedAgentImage.runtimeType === 'codex' ? 'codex' : 'claude',
    role: roleId,
    sessionName: displayName,
    teamId: opts.teamId,
    env: materializedEnv,
    ...(specResolution.specId ? { specId: specResolution.specId } : {}),
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

  let publishedCorpsTemplate: Awaited<ReturnType<typeof publishTeamCorpsTemplate>> | null = null;
  if (opts.teamId && sessionId) {
    try {
      await api.addTeamMember(opts.teamId, sessionId, roleId, displayName, {
        specId: specResolution.specId ?? undefined,
        executionPlane: 'mainline',
        runtimeType: opts.model === 'codex' ? 'codex' : 'claude',
        // Coordinator roles need task.create authority; genome spec can add more via authorities[].
        ...(COORDINATION_ROLES.includes(roleId) ? { authorities: ['task.create'] } : {}),
      });

      publishedCorpsTemplate = await publishTeamCorpsTemplate({
        api,
        teamId: opts.teamId,
      });
    } catch (err) {
      logger.debug('[agents create] Warning: failed to register in team roster:', err);
    }
  }

  if (opts.asJson) {
    console.log(JSON.stringify({
      sessionId,
      agentId,
      role: roleId,
      teamId: opts.teamId || null,
      name: displayName,
      specId: specResolution.specId,
      specSource: specResolution.source,
      corpsTemplate: publishedCorpsTemplate?.published
        ? {
            templateName: publishedCorpsTemplate.templateName,
            templateId: publishedCorpsTemplate.templateId,
          }
        : null,
    }, null, 2));
    return;
  }

  console.log(chalk.green(`✓ Agent created: ${sessionId}`));
  console.log(chalk.gray(`  role=${roleId} model=${opts.model} teamId=${opts.teamId || '-'} name=${displayName}`));
  if (specResolution.specId) {
    console.log(chalk.gray(`  specId=${specResolution.specId} (${specResolution.source})`));
  }
  if (publishedCorpsTemplate?.published) {
    console.log(chalk.gray(`  corpsTemplate=${publishedCorpsTemplate.templateName}`));
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
    commandsDir: plan.commandsDir,
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

function printCcLogEntry(entry: any, verbose: boolean): void {
  const type = entry?.type ?? entry?.message?.type;
  const role = entry?.message?.role ?? entry?.role;
  const content = entry?.message?.content ?? entry?.content;

  if (type === 'system') {
    if (verbose) {
      console.log(chalk.gray(`  [system] ${JSON.stringify(entry).slice(0, 120)}`));
    }
    return;
  }

  if (role === 'user') {
    const text = Array.isArray(content)
      ? content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join(' ').slice(0, 200)
      : typeof content === 'string' ? content.slice(0, 200) : '';
    if (text) {
      console.log(`${chalk.cyan('→ user')}  ${chalk.white(text)}`);
    }
    return;
  }

  if (role === 'assistant') {
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && block.text) {
          console.log(`${chalk.green('← asst')}  ${chalk.white(block.text.slice(0, 300))}`);
        } else if (block?.type === 'tool_use') {
          const inputStr = block.input ? JSON.stringify(block.input).slice(0, 100) : '';
          console.log(`${chalk.yellow('⚙ tool')}  ${chalk.bold(block.name)} ${chalk.gray(inputStr)}`);
        }
      }
    } else if (typeof content === 'string' && content) {
      console.log(`${chalk.green('← asst')}  ${chalk.white(content.slice(0, 300))}`);
    }
    return;
  }

  if (type === 'tool_result') {
    if (verbose) {
      const resultText = Array.isArray(entry.content)
        ? entry.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join(' ').slice(0, 150)
        : '';
      if (resultText) {
        console.log(`${chalk.magenta('✓ tool')}  ${chalk.gray(resultText)}`);
      }
    }
    return;
  }

  if (verbose) {
    console.log(chalk.gray(`  [${type || 'unknown'}] ${JSON.stringify(entry).slice(0, 120)}`));
  }
}

async function logsAgent(
  api: ApiClient,
  sessionId: string,
  opts: { lines: number; asJson: boolean; verbose: boolean },
): Promise<void> {
  const session = await api.getSession(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  let claudeLocalSessionId: string | undefined;
  try {
    const teamId = session.metadata?.teamId || session.metadata?.roomId;
    if (teamId) {
      const isRunning = await checkIfDaemonRunningAndCleanupStaleState();
      if (isRunning) {
        const result = await daemonPost('/list-team-sessions', { teamId });
        const teamSessions: Array<{ ahaSessionId: string; claudeLocalSessionId?: string }> = result?.sessions ?? [];
        const match = teamSessions.find(s => s.ahaSessionId === sessionId);
        claudeLocalSessionId = match?.claudeLocalSessionId;
      }
    }
  } catch (error) {
    logger.debug('[agent logs] Failed to resolve daemon session info (non-fatal):', error);
  }

  const logFilePath = claudeLocalSessionId ? findClaudeLogFile(homedir(), claudeLocalSessionId) : null;

  if (opts.asJson) {
    console.log(JSON.stringify({
      sessionId,
      claudeLocalSessionId: claudeLocalSessionId ?? null,
      logFilePath,
      session: sanitizeSession(session),
    }, null, 2));
    return;
  }

  console.log(chalk.bold(`\nAgent: ${sessionId}\n`));
  printSession(session, opts.verbose);

  if (!claudeLocalSessionId) {
    console.log(chalk.gray('\n  (No active daemon session found — agent may not be running or belongs to no team)'));
    console.log();
    return;
  }

  if (!logFilePath) {
    console.log(chalk.gray(`\n  (CC log not found for local session: ${claudeLocalSessionId})`));
    console.log();
    return;
  }

  console.log(chalk.bold(`\nCC Log: ${chalk.gray(logFilePath)}`));
  const raw = readFileSync(logFilePath, 'utf-8');
  const lines = raw.split('\n').filter(Boolean);
  const tail = lines.slice(-opts.lines);
  console.log(chalk.gray(`  (last ${tail.length} of ${lines.length} entries)\n`));

  for (const line of tail) {
    try {
      const entry = JSON.parse(line);
      printCcLogEntry(entry, opts.verbose);
    } catch {
      console.log(chalk.gray(`  ${line.slice(0, 120)}`));
    }
  }
  console.log();
}
