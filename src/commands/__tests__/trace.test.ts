/**
 * Tests for the `aha trace` CLI command handler
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initTraceDb,
  closeTraceDb,
  insertEvent,
  resolveTraceDbPath,
} from '@/trace/traceStore';
import { TraceEventKind } from '@/trace/traceTypes';
import type { TraceEvent } from '@/trace/traceTypes';
import { parseDuration, handleTraceCommand } from '../trace';

// ── Test helpers ────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `trace-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ts: Date.now(),
    kind: TraceEventKind.spawn_requested,
    level: 'info',
    source: 'test',
    trace_id: 'trace-001',
    span_id: 'span-001',
    parent_span_id: null,
    team_id: 'team-001',
    task_id: null,
    session_id: null,
    member_id: null,
    run_id: null,
    pid: process.pid,
    summary: 'test event',
    status: 'ok',
    payload_ref: null,
    attrs_json: null,
    ...overrides,
  };
}

// ── parseDuration tests ─────────────────────────────────────────────────────

describe('parseDuration', () => {
  it('parses seconds', () => {
    expect(parseDuration('30s')).toBe(30 * 1000);
  });

  it('parses minutes', () => {
    expect(parseDuration('5m')).toBe(5 * 60 * 1000);
  });

  it('parses hours', () => {
    expect(parseDuration('2h')).toBe(2 * 60 * 60 * 1000);
  });

  it('parses days', () => {
    expect(parseDuration('1d')).toBe(24 * 60 * 60 * 1000);
  });

  it('throws on invalid format', () => {
    expect(() => parseDuration('abc')).toThrow('Invalid duration format');
    expect(() => parseDuration('30')).toThrow('Invalid duration format');
    expect(() => parseDuration('30x')).toThrow('Invalid duration format');
  });
});

// ── handleTraceCommand tests (using real DB) ────────────────────────────────

describe('handleTraceCommand', () => {
  let tmpDir: string;
  let dbPath: string;
  let originalHome: string | undefined;
  let capturedOutput: string[];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  /**
   * Seed data into the DB, then close it so handleTraceCommand can re-open.
   * The command manages its own DB lifecycle via ensureTraceDb / closeTraceDb.
   */
  function seedAndClose(fn: () => void): void {
    initTraceDb(dbPath);
    fn();
    closeTraceDb();
  }

  beforeEach(() => {
    tmpDir = makeTmpDir();

    // Override HOME so resolveTraceDbPath uses our temp dir
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;

    // Resolve the path that handleTraceCommand will use
    dbPath = resolveTraceDbPath();

    // Capture console output
    capturedOutput = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (...args: unknown[]) => {
      capturedOutput.push(args.map(String).join(' '));
    };
    console.error = (...args: unknown[]) => {
      capturedOutput.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    closeTraceDb();
    console.log = originalLog;
    console.error = originalError;
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('shows help with --help flag', async () => {
    await handleTraceCommand(['--help']);
    const output = capturedOutput.join('\n');
    expect(output).toContain('aha trace');
    expect(output).toContain('team');
    expect(output).toContain('session');
    expect(output).toContain('errors');
  });

  it('shows help with no subcommand', async () => {
    await handleTraceCommand([]);
    const output = capturedOutput.join('\n');
    expect(output).toContain('aha trace');
  });

  describe('team subcommand', () => {
    it('returns events for a team', async () => {
      seedAndClose(() => {
        insertEvent(makeEvent({ id: 'evt-t1', team_id: 'team-abc', summary: 'spawn requested' }));
        insertEvent(makeEvent({ id: 'evt-t2', team_id: 'team-abc', summary: 'process started', kind: TraceEventKind.process_started }));
      });

      await handleTraceCommand(['team', 'team-abc']);
      const output = capturedOutput.join('\n');
      expect(output).toContain('spawn requested');
      expect(output).toContain('process started');
      expect(output).toContain('2 event(s)');
    });

    it('returns no events for unknown team', async () => {
      seedAndClose(() => {});

      await handleTraceCommand(['team', 'nonexistent']);
      const output = capturedOutput.join('\n');
      expect(output).toContain('No trace events found');
    });
  });

  describe('session subcommand', () => {
    it('returns events for a session', async () => {
      seedAndClose(() => {
        insertEvent(makeEvent({ id: 'evt-s1', session_id: 'sess-xyz', summary: 'session event' }));
      });

      await handleTraceCommand(['session', 'sess-xyz']);
      const output = capturedOutput.join('\n');
      expect(output).toContain('session event');
      expect(output).toContain('1 event(s)');
    });
  });

  describe('task subcommand', () => {
    it('returns events for a task', async () => {
      seedAndClose(() => {
        insertEvent(makeEvent({ id: 'evt-tk1', task_id: 'task-123', summary: 'task created', kind: TraceEventKind.task_created }));
      });

      await handleTraceCommand(['task', 'task-123']);
      const output = capturedOutput.join('\n');
      expect(output).toContain('task created');
    });
  });

  describe('errors subcommand', () => {
    it('returns error events', async () => {
      seedAndClose(() => {
        insertEvent(makeEvent({ id: 'evt-ok', level: 'info', status: 'ok', summary: 'good event' }));
        insertEvent(makeEvent({ id: 'evt-err', level: 'error', status: 'failed', summary: 'bad event' }));
      });

      await handleTraceCommand(['errors']);
      const output = capturedOutput.join('\n');
      expect(output).toContain('bad event');
      expect(output).not.toContain('good event');
    });

    it('supports --since flag', async () => {
      const now = Date.now();
      seedAndClose(() => {
        insertEvent(makeEvent({ id: 'old-err', ts: now - 3 * 60 * 60 * 1000, level: 'error', summary: 'old error' }));
        insertEvent(makeEvent({ id: 'new-err', ts: now, level: 'error', summary: 'new error' }));
      });

      await handleTraceCommand(['errors', '--since', '1h']);
      const output = capturedOutput.join('\n');
      expect(output).toContain('new error');
      expect(output).not.toContain('old error');
    });
  });

  describe('--json flag', () => {
    it('outputs valid JSON array', async () => {
      seedAndClose(() => {
        insertEvent(makeEvent({ id: 'evt-json', team_id: 'team-json', summary: 'json test' }));
      });

      await handleTraceCommand(['team', 'team-json', '--json']);
      const output = capturedOutput.join('\n');
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe('evt-json');
    });
  });

  describe('--full flag', () => {
    it('expands payload_ref in output', async () => {
      const ref = JSON.stringify({ source: 'daemon_log', path: '/tmp/daemon.log', offset: 100 });
      seedAndClose(() => {
        insertEvent(makeEvent({
          id: 'evt-full',
          team_id: 'team-full',
          summary: 'event with payload',
          payload_ref: ref,
        }));
      });

      await handleTraceCommand(['team', 'team-full', '--full']);
      const output = capturedOutput.join('\n');
      expect(output).toContain('daemon_log');
      expect(output).toContain('/tmp/daemon.log');
    });
  });

  describe('--limit flag', () => {
    it('limits result count', async () => {
      seedAndClose(() => {
        for (let i = 0; i < 10; i++) {
          insertEvent(makeEvent({ id: `evt-lim-${i}`, ts: 1000 + i, team_id: 'team-lim' }));
        }
      });

      await handleTraceCommand(['team', 'team-lim', '--limit', '3']);
      const output = capturedOutput.join('\n');
      expect(output).toContain('3 event(s)');
    });
  });
});
