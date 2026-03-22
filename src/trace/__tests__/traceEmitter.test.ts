/**
 * Tests for traceEmitter module — event emission and link creation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initTraceDb,
  closeTraceDb,
  queryByTeam,
  queryLinksFrom,
} from '../traceStore';
import { TraceEventKind } from '../traceTypes';
import { emitTraceEvent, emitTraceLink, buildPayloadRef } from '../traceEmitter';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `trace-emit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('traceEmitter', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    dbPath = join(tmpDir, 'trace', 'trace.db');
    initTraceDb(dbPath);
  });

  afterEach(() => {
    closeTraceDb();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('emitTraceEvent', () => {
    it('creates an event with a ULID id', () => {
      const eventId = emitTraceEvent(
        TraceEventKind.spawn_requested,
        'test',
        { team_id: 'team-emit' },
        'test spawn event',
      );

      expect(eventId).not.toBeNull();
      expect(eventId).toHaveLength(26);
      expect(eventId).toMatch(/^[0-9A-Z]{26}$/);
    });

    it('writes event to the store and can be queried', () => {
      emitTraceEvent(
        TraceEventKind.spawn_requested,
        'daemon',
        { team_id: 'team-query', task_id: 'task-123' },
        'org-manager requested codex researcher spawn',
      );

      const events = queryByTeam('team-query');
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('spawn_requested');
      expect(events[0].source).toBe('daemon');
      expect(events[0].task_id).toBe('task-123');
      expect(events[0].summary).toBe('org-manager requested codex researcher spawn');
    });

    it('auto-populates trace_id from context', () => {
      const origEnv = process.env.AHA_TRACE_ID;
      process.env.AHA_TRACE_ID = 'CONTEXT_TRACE_ID';

      emitTraceEvent(
        TraceEventKind.task_created,
        'mcp',
        { team_id: 'team-ctx' },
        'task created',
      );

      const events = queryByTeam('team-ctx');
      expect(events[0].trace_id).toBe('CONTEXT_TRACE_ID');

      // Restore
      if (origEnv !== undefined) {
        process.env.AHA_TRACE_ID = origEnv;
      } else {
        delete process.env.AHA_TRACE_ID;
      }
    });

    it('uses provided trace_id over context', () => {
      emitTraceEvent(
        TraceEventKind.task_created,
        'mcp',
        { team_id: 'team-explicit', trace_id: 'EXPLICIT_TRACE' },
        'task with explicit trace',
      );

      const events = queryByTeam('team-explicit');
      expect(events[0].trace_id).toBe('EXPLICIT_TRACE');
    });

    it('sets span_id to event id when not provided', () => {
      const eventId = emitTraceEvent(
        TraceEventKind.process_started,
        'daemon',
        { team_id: 'team-span' },
        'process started',
      );

      const events = queryByTeam('team-span');
      expect(events[0].span_id).toBe(eventId);
    });

    it('populates pid from process.pid', () => {
      emitTraceEvent(
        TraceEventKind.daemon_started,
        'daemon',
        { team_id: 'team-pid' },
        'daemon started',
      );

      const events = queryByTeam('team-pid');
      expect(events[0].pid).toBe(process.pid);
    });

    it('supports optional level, status, payloadRef, attrs', () => {
      const ref = buildPayloadRef('team_messages', '/tmp/msgs.jsonl', 100, 500);

      emitTraceEvent(
        TraceEventKind.daemon_error,
        'daemon',
        { team_id: 'team-opts' },
        'daemon encountered error',
        {
          level: 'error',
          status: 'failed',
          payloadRef: ref,
          attrs: { errorCode: 42, retryable: true },
        },
      );

      const events = queryByTeam('team-opts');
      expect(events[0].level).toBe('error');
      expect(events[0].status).toBe('failed');

      const parsedRef = JSON.parse(events[0].payload_ref!);
      expect(parsedRef.source).toBe('team_messages');
      expect(parsedRef.path).toBe('/tmp/msgs.jsonl');
      expect(parsedRef.offset).toBe(100);
      expect(parsedRef.length).toBe(500);

      const parsedAttrs = JSON.parse(events[0].attrs_json!);
      expect(parsedAttrs.errorCode).toBe(42);
      expect(parsedAttrs.retryable).toBe(true);
    });

    it('truncates summary to 300 characters', () => {
      const longSummary = 'x'.repeat(500);
      emitTraceEvent(
        TraceEventKind.task_started,
        'test',
        { team_id: 'team-trunc' },
        longSummary,
      );

      const events = queryByTeam('team-trunc');
      expect(events[0].summary).toHaveLength(300);
    });

    it('returns null on failure without throwing', () => {
      // Close DB to simulate failure
      closeTraceDb();

      const result = emitTraceEvent(
        TraceEventKind.spawn_requested,
        'test',
        { team_id: 'team-fail' },
        'should fail gracefully',
      );

      expect(result).toBeNull();
    });

    it('validates event kind', () => {
      // This should fail gracefully (return null) for invalid kind
      const result = emitTraceEvent(
        'not_a_real_kind' as TraceEventKind,
        'test',
        { team_id: 'team-invalid' },
        'invalid kind test',
      );

      expect(result).toBeNull();
    });
  });

  describe('emitTraceLink', () => {
    it('creates a causal link between events', () => {
      const id1 = emitTraceEvent(
        TraceEventKind.spawn_requested,
        'mcp',
        { team_id: 'team-link' },
        'spawn requested',
      );

      const id2 = emitTraceEvent(
        TraceEventKind.spawn_started,
        'daemon',
        { team_id: 'team-link' },
        'spawn started',
      );

      expect(id1).not.toBeNull();
      expect(id2).not.toBeNull();

      const success = emitTraceLink(id1!, id2!, 'caused_by');
      expect(success).toBe(true);

      const links = queryLinksFrom(id1!);
      expect(links).toHaveLength(1);
      expect(links[0].to_event_id).toBe(id2);
      expect(links[0].rel).toBe('caused_by');
    });

    it('returns false on invalid relation', () => {
      const result = emitTraceLink('a', 'b', 'invalid' as any);
      expect(result).toBe(false);
    });

    it('returns false on DB failure without throwing', () => {
      closeTraceDb();

      const result = emitTraceLink('a', 'b', 'caused_by');
      expect(result).toBe(false);
    });
  });

  describe('buildPayloadRef', () => {
    it('builds a minimal ref with source and path', () => {
      const ref = buildPayloadRef('daemon_log', '/var/log/daemon.log');
      expect(ref).toEqual({
        source: 'daemon_log',
        path: '/var/log/daemon.log',
      });
    });

    it('includes offset and length when provided', () => {
      const ref = buildPayloadRef('cc_log', '/tmp/cc.jsonl', 1024, 256);
      expect(ref).toEqual({
        source: 'cc_log',
        path: '/tmp/cc.jsonl',
        offset: 1024,
        length: 256,
      });
    });

    it('omits offset/length when not provided', () => {
      const ref = buildPayloadRef('team_messages', '/tmp/msgs.jsonl');
      expect(ref).not.toHaveProperty('offset');
      expect(ref).not.toHaveProperty('length');
    });
  });
});
