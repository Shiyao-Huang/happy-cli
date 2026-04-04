/**
 * CLI Command: aha trace
 *
 * Unified trace query interface — merged timelines for teams, sessions,
 * tasks, members, runs, and error views.
 *
 * Usage:
 *   aha trace team <teamId>          — all events for a team
 *   aha trace session <sessionId>    — single agent timeline
 *   aha trace task <taskId>          — task lifecycle
 *   aha trace member <memberId>      — all events for a member
 *   aha trace run <runId>            — process-level events
 *   aha trace errors [--since <dur>] — recent errors/failures
 *
 * Flags:
 *   --json     Machine-readable JSON output
 *   --full     Expand payloadRef (show original content pointers)
 *   --since    Time filter, e.g. "30m", "2h", "1d"
 *   --limit    Max events to return (default: 200)
 */

import chalk from 'chalk';
import {
  initTraceDb,
  closeTraceDb,
  queryByTeam,
  queryBySession,
  queryByTask,
  queryByMember,
  queryByRun,
  queryByTraceId,
  queryErrors,
  queryLinksFrom,
  resolveTraceDbPath,
} from '@/trace/traceStore';
import type { TraceEvent, TraceQueryOpts } from '@/trace/traceTypes';
import { existsSync } from 'node:fs';

// ── Arg parsing helpers ─────────────────────────────────────────────────────

function getOption(args: string[], name: string): string | undefined {
  const flag = `--${name}`;
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return flags.some((f) => args.includes(f));
}

function getPositionalArgs(args: string[]): string[] {
  const positional: string[] = [];
  const booleanFlags = new Set(['--json', '--full', '--help', '-h']);

  for (let i = 0; i < args.length; i++) {
    const val = args[i];
    if (val.startsWith('-')) {
      if (!booleanFlags.has(val) && i + 1 < args.length && !args[i + 1].startsWith('-')) {
        i++;
      }
      continue;
    }
    positional.push(val);
  }
  return positional;
}

// ── Duration parsing ────────────────────────────────────────────────────────

/**
 * Parse a human-readable duration string into milliseconds.
 * Supported formats: "30m", "2h", "1d", "90s"
 */
export function parseDuration(input: string): number {
  const match = input.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i);
  if (!match) {
    throw new Error(`Invalid duration format: "${input}". Use e.g. "30m", "2h", "1d"`);
  }

  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return Math.floor(value * multipliers[unit]);
}

// ── Output formatting ───────────────────────────────────────────────────────

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function levelColor(level: string): (text: string) => string {
  switch (level) {
    case 'error': return chalk.red;
    case 'warn': return chalk.yellow;
    case 'debug': return chalk.gray;
    default: return chalk.white;
  }
}

function kindColor(kind: string): (text: string) => string {
  if (kind.startsWith('spawn_')) return chalk.cyan;
  if (kind.startsWith('task_')) return chalk.green;
  if (kind.startsWith('help_')) return chalk.magenta;
  if (kind.startsWith('score_') || kind.startsWith('feedback_')) return chalk.blue;
  if (kind.startsWith('daemon_') || kind.startsWith('auth_')) return chalk.yellow;
  if (kind.startsWith('supervisor_')) return chalk.gray;
  if (kind.startsWith('session_') || kind.startsWith('agent_')) return chalk.red;
  return chalk.white;
}

function formatTimelineEvent(event: TraceEvent, showFull: boolean): string {
  const ts = formatTimestamp(event.ts);
  const kind = event.kind.padEnd(28);
  const summary = event.summary ?? '';
  const colorize = levelColor(event.level);
  const colorKind = kindColor(event.kind);

  let line = `${chalk.gray(ts)} ${colorKind(kind)} ${colorize(summary)}`;

  if (event.status && event.status !== 'ok') {
    line += chalk.yellow(` [${event.status}]`);
  }

  if (showFull && event.payload_ref) {
    try {
      const ref = JSON.parse(event.payload_ref);
      line += chalk.gray(`\n           → ${ref.source}: ${ref.path}`);
      if (ref.offset != null) {
        line += chalk.gray(` @${ref.offset}`);
        if (ref.length != null) line += chalk.gray(`+${ref.length}`);
      }
    } catch {
      // ignore malformed payload_ref
    }
  }

  return line;
}

function printTimeline(events: TraceEvent[], showFull: boolean): void {
  if (events.length === 0) {
    console.log(chalk.gray('No trace events found.'));
    return;
  }

  for (const event of events) {
    console.log(formatTimelineEvent(event, showFull));
  }

  console.log(chalk.gray(`\n— ${events.length} event(s) —`));
}

function printJson(events: TraceEvent[]): void {
  console.log(JSON.stringify(events, null, 2));
}

// ── Help ────────────────────────────────────────────────────────────────────

function showTraceHelp(): void {
  console.log(`
${chalk.bold('aha trace')} — Unified trace query interface

${chalk.bold('Usage:')}
  aha trace team <teamId>             Team event timeline
  aha trace session <sessionId>       Single agent event timeline
  aha trace task <taskId>             Task lifecycle events
  aha trace member <memberId>         All events for a team member
  aha trace run <runId>               Process-level events
  aha trace errors [--since <dur>]    Recent errors and failures

${chalk.bold('Flags:')}
  --json          Machine-readable JSON output
  --format <json|table>  Select JSON or human output mode
  --full          Expand payload references
  --since <dur>   Time filter: "30m", "2h", "1d"
  --limit <n>     Max events (default: 200)
  -h, --help      Show this help

${chalk.bold('Examples:')}
  ${chalk.green('aha trace team abc-123')}
  ${chalk.green('aha trace session sess-456 --json')}
  ${chalk.green('aha trace errors --since 1h')}
  ${chalk.green('aha trace task task-789 --full')}
`);
}

// ── DB initialization helper ────────────────────────────────────────────────

function ensureTraceDb(): boolean {
  const dbPath = resolveTraceDbPath();
  if (!existsSync(dbPath)) {
    // DB doesn't exist yet — initialize it (creates empty DB)
    try {
      initTraceDb(dbPath);
      return true;
    } catch (err) {
      console.error(chalk.red('Failed to initialize trace database:'), err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  try {
    initTraceDb(dbPath);
    return true;
  } catch (err) {
    console.error(chalk.red('Failed to open trace database:'), err instanceof Error ? err.message : String(err));
    return false;
  }
}

// ── Build query opts from CLI flags ─────────────────────────────────────────

function buildQueryOpts(args: string[]): TraceQueryOpts {
  const opts: TraceQueryOpts = {};

  const sinceStr = getOption(args, 'since');
  if (sinceStr) {
    const ms = parseDuration(sinceStr);
    opts.since = Date.now() - ms;
  }

  const limitStr = getOption(args, 'limit');
  opts.limit = limitStr ? parseInt(limitStr, 10) : 200;

  return opts;
}

// ── Main command handler ────────────────────────────────────────────────────

export async function handleTraceCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === 'help' || hasFlag(args, '--help', '-h')) {
    showTraceHelp();
    return;
  }

  const positional = getPositionalArgs(args);
  const asJson = hasFlag(args, '--json');
  const showFull = hasFlag(args, '--full');
  const queryOpts = buildQueryOpts(args);

  if (!ensureTraceDb()) {
    process.exit(1);
  }

  try {
    let events: TraceEvent[];

    switch (subcommand) {
      case 'team': {
        const teamId = positional[1];
        if (!teamId) {
          console.error(chalk.red('Usage: aha trace team <teamId>'));
          process.exit(1);
        }
        events = queryByTeam(teamId, queryOpts);
        break;
      }

      case 'session': {
        const sessionId = positional[1];
        if (!sessionId) {
          console.error(chalk.red('Usage: aha trace session <sessionId>'));
          process.exit(1);
        }
        events = queryBySession(sessionId, queryOpts);
        break;
      }

      case 'task': {
        const taskId = positional[1];
        if (!taskId) {
          console.error(chalk.red('Usage: aha trace task <taskId>'));
          process.exit(1);
        }
        events = queryByTask(taskId, queryOpts);
        break;
      }

      case 'member': {
        const memberId = positional[1];
        if (!memberId) {
          console.error(chalk.red('Usage: aha trace member <memberId>'));
          process.exit(1);
        }
        events = queryByMember(memberId, queryOpts);
        break;
      }

      case 'run': {
        const runId = positional[1];
        if (!runId) {
          console.error(chalk.red('Usage: aha trace run <runId>'));
          process.exit(1);
        }
        events = queryByRun(runId, queryOpts);
        break;
      }

      case 'errors': {
        events = queryErrors(queryOpts);
        break;
      }

      default:
        console.error(chalk.red(`Unknown trace subcommand: ${subcommand}`));
        showTraceHelp();
        process.exit(1);
    }

    if (asJson) {
      printJson(events);
    } else {
      printTimeline(events, showFull);
    }
  } finally {
    closeTraceDb();
  }
}
