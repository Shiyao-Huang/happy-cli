/**
 * Tests for traceStore module — SQLite CRUD for trace events and links
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initTraceDb,
  closeTraceDb,
  insertEvent,
  insertLink,
  queryByTeam,
  queryBySession,
  queryByTask,
  queryByMember,
  queryByRun,
  queryByTraceId,
  queryErrors,
  queryLinksFrom,
  queryLinksTo,
  archiveOlderThan,
  resolveTraceDbPath,
} from '../traceStore';
import { TraceEventKind } from '../traceTypes';
import type { TraceEvent, TraceLink } from '../traceTypes';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `trace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe('traceStore', () => {
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

  describe('resolveTraceDbPath', () => {
    it('returns path under given directory', () => {
      const path = resolveTraceDbPath('/custom/home');
      expect(path).toBe('/custom/home/trace/trace.db');
    });

    it('defaults to HOME/.aha when no arg given', () => {
      const path = resolveTraceDbPath();
      expect(path).toContain('trace/trace.db');
    });
  });

  describe('initTraceDb', () => {
    it('creates the database file', () => {
      expect(existsSync(dbPath)).toBe(true);
    });

    it('creates trace_events table', () => {
      // Verify by inserting and querying an event
      const evt = makeEvent();
      insertEvent(evt);
      const results = queryByTeam('team-001');
      expect(results).toHaveLength(1);
    });

    it('creates trace_links table', () => {
      const evt1 = makeEvent({ id: 'evt-link-1' });
      const evt2 = makeEvent({ id: 'evt-link-2' });
      insertEvent(evt1);
      insertEvent(evt2);

      const link: TraceLink = {
        from_event_id: 'evt-link-1',
        to_event_id: 'evt-link-2',
        rel: 'caused_by',
      };
      insertLink(link);

      const links = queryLinksFrom('evt-link-1');
      expect(links).toHaveLength(1);
      expect(links[0].rel).toBe('caused_by');
    });
  });

  describe('insertEvent + queryByTeam', () => {
    it('round-trips a complete event', () => {
      const evt = makeEvent({
        id: 'roundtrip-001',
        ts: 1700000000000,
        kind: TraceEventKind.spawn_requested,
        level: 'info',
        source: 'daemon',
        trace_id: 'trace-rt',
        span_id: 'span-rt',
        parent_span_id: 'parent-rt',
        team_id: 'team-rt',
        task_id: 'task-rt',
        session_id: 'session-rt',
        member_id: 'member-rt',
        run_id: 'run-rt',
        pid: 12345,
        summary: 'round trip test',
        status: 'ok',
        payload_ref: '{"source":"test","path":"/tmp/log"}',
        attrs_json: '{"key":"value"}',
      });

      insertEvent(evt);
      const results = queryByTeam('team-rt');

      expect(results).toHaveLength(1);
      const r = results[0];
      expect(r.id).toBe('roundtrip-001');
      expect(r.ts).toBe(1700000000000);
      expect(r.kind).toBe('spawn_requested');
      expect(r.level).toBe('info');
      expect(r.source).toBe('daemon');
      expect(r.trace_id).toBe('trace-rt');
      expect(r.span_id).toBe('span-rt');
      expect(r.parent_span_id).toBe('parent-rt');
      expect(r.team_id).toBe('team-rt');
      expect(r.task_id).toBe('task-rt');
      expect(r.session_id).toBe('session-rt');
      expect(r.member_id).toBe('member-rt');
      expect(r.run_id).toBe('run-rt');
      expect(r.pid).toBe(12345);
      expect(r.summary).toBe('round trip test');
      expect(r.status).toBe('ok');
      expect(r.payload_ref).toBe('{"source":"test","path":"/tmp/log"}');
      expect(r.attrs_json).toBe('{"key":"value"}');
    });

    it('returns events ordered by timestamp', () => {
      insertEvent(makeEvent({ id: 'e3', ts: 3000, team_id: 'team-ord' }));
      insertEvent(makeEvent({ id: 'e1', ts: 1000, team_id: 'team-ord' }));
      insertEvent(makeEvent({ id: 'e2', ts: 2000, team_id: 'team-ord' }));

      const results = queryByTeam('team-ord');
      expect(results.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
    });

    it('filters by team_id', () => {
      insertEvent(makeEvent({ id: 'ta', team_id: 'team-a' }));
      insertEvent(makeEvent({ id: 'tb', team_id: 'team-b' }));
      insertEvent(makeEvent({ id: 'ta2', team_id: 'team-a' }));

      expect(queryByTeam('team-a')).toHaveLength(2);
      expect(queryByTeam('team-b')).toHaveLength(1);
      expect(queryByTeam('team-c')).toHaveLength(0);
    });
  });

  describe('queryBySession', () => {
    it('filters by session_id', () => {
      insertEvent(makeEvent({ id: 'sa', session_id: 'sess-a' }));
      insertEvent(makeEvent({ id: 'sb', session_id: 'sess-b' }));

      expect(queryBySession('sess-a')).toHaveLength(1);
      expect(queryBySession('sess-a')[0].id).toBe('sa');
    });
  });

  describe('queryByTask', () => {
    it('filters by task_id', () => {
      insertEvent(makeEvent({ id: 'ta', task_id: 'task-a' }));
      insertEvent(makeEvent({ id: 'tb', task_id: 'task-b' }));

      expect(queryByTask('task-a')).toHaveLength(1);
      expect(queryByTask('task-a')[0].id).toBe('ta');
    });
  });

  describe('queryByMember', () => {
    it('filters by member_id', () => {
      insertEvent(makeEvent({ id: 'ma', member_id: 'member-a' }));
      insertEvent(makeEvent({ id: 'mb', member_id: 'member-b' }));

      expect(queryByMember('member-a')).toHaveLength(1);
    });
  });

  describe('queryByRun', () => {
    it('filters by run_id', () => {
      insertEvent(makeEvent({ id: 'ra', run_id: 'run-a' }));
      expect(queryByRun('run-a')).toHaveLength(1);
    });
  });

  describe('queryByTraceId', () => {
    it('filters by trace_id', () => {
      insertEvent(makeEvent({ id: 'tr1', trace_id: 'trace-x' }));
      insertEvent(makeEvent({ id: 'tr2', trace_id: 'trace-y' }));

      expect(queryByTraceId('trace-x')).toHaveLength(1);
    });
  });

  describe('query options', () => {
    it('supports since/until time filtering', () => {
      insertEvent(makeEvent({ id: 'old', ts: 1000, team_id: 'team-time' }));
      insertEvent(makeEvent({ id: 'mid', ts: 2000, team_id: 'team-time' }));
      insertEvent(makeEvent({ id: 'new', ts: 3000, team_id: 'team-time' }));

      const results = queryByTeam('team-time', { since: 1500, until: 2500 });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('mid');
    });

    it('supports kind filtering', () => {
      insertEvent(makeEvent({ id: 'spawn', team_id: 'team-kind', kind: TraceEventKind.spawn_requested }));
      insertEvent(makeEvent({ id: 'task', team_id: 'team-kind', kind: TraceEventKind.task_created }));

      const results = queryByTeam('team-kind', { kind: TraceEventKind.task_created });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('task');
    });

    it('supports level filtering', () => {
      insertEvent(makeEvent({ id: 'info-evt', team_id: 'team-level', level: 'info' }));
      insertEvent(makeEvent({ id: 'error-evt', team_id: 'team-level', level: 'error' }));

      const results = queryByTeam('team-level', { level: 'error' });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('error-evt');
    });

    it('supports limit and offset', () => {
      for (let i = 0; i < 10; i++) {
        insertEvent(makeEvent({ id: `pg-${i}`, ts: 1000 + i, team_id: 'team-page' }));
      }

      const page1 = queryByTeam('team-page', { limit: 3, offset: 0 });
      expect(page1).toHaveLength(3);
      expect(page1[0].id).toBe('pg-0');

      const page2 = queryByTeam('team-page', { limit: 3, offset: 3 });
      expect(page2).toHaveLength(3);
      expect(page2[0].id).toBe('pg-3');
    });
  });

  describe('queryErrors', () => {
    it('returns events with level=error or status=failed', () => {
      insertEvent(makeEvent({ id: 'ok-evt', level: 'info', status: 'ok' }));
      insertEvent(makeEvent({ id: 'err-evt', level: 'error', status: 'ok' }));
      insertEvent(makeEvent({ id: 'fail-evt', level: 'info', status: 'failed' }));

      const errors = queryErrors();
      expect(errors).toHaveLength(2);
      const ids = errors.map((e) => e.id);
      expect(ids).toContain('err-evt');
      expect(ids).toContain('fail-evt');
    });

    it('supports since filtering', () => {
      insertEvent(makeEvent({ id: 'old-err', ts: 1000, level: 'error' }));
      insertEvent(makeEvent({ id: 'new-err', ts: 3000, level: 'error' }));

      const errors = queryErrors({ since: 2000 });
      expect(errors).toHaveLength(1);
      expect(errors[0].id).toBe('new-err');
    });
  });

  describe('insertLink + queryLinks', () => {
    it('inserts and queries links from an event', () => {
      insertEvent(makeEvent({ id: 'from-1' }));
      insertEvent(makeEvent({ id: 'to-1' }));

      insertLink({ from_event_id: 'from-1', to_event_id: 'to-1', rel: 'caused_by' });

      const from = queryLinksFrom('from-1');
      expect(from).toHaveLength(1);
      expect(from[0].to_event_id).toBe('to-1');
      expect(from[0].rel).toBe('caused_by');

      const to = queryLinksTo('to-1');
      expect(to).toHaveLength(1);
      expect(to[0].from_event_id).toBe('from-1');
    });

    it('rejects invalid link relations', () => {
      expect(() =>
        insertLink({
          from_event_id: 'x',
          to_event_id: 'y',
          rel: 'invalid_rel' as any,
        })
      ).toThrow('Invalid trace link relation');
    });

    it('ignores duplicate links (INSERT OR IGNORE)', () => {
      insertEvent(makeEvent({ id: 'dup-from' }));
      insertEvent(makeEvent({ id: 'dup-to' }));

      const link: TraceLink = { from_event_id: 'dup-from', to_event_id: 'dup-to', rel: 'caused_by' };
      insertLink(link);
      insertLink(link); // should not throw

      const links = queryLinksFrom('dup-from');
      expect(links).toHaveLength(1);
    });

    it('supports all 6 relation types', () => {
      const rels: Array<TraceLink['rel']> = [
        'caused_by', 'spawned_from', 'belongs_to_task',
        'retries', 'replaces', 'reads_log_of',
      ];

      for (let i = 0; i < rels.length; i++) {
        insertEvent(makeEvent({ id: `rel-from-${i}` }));
        insertEvent(makeEvent({ id: `rel-to-${i}` }));
        insertLink({
          from_event_id: `rel-from-${i}`,
          to_event_id: `rel-to-${i}`,
          rel: rels[i],
        });
      }

      for (let i = 0; i < rels.length; i++) {
        const links = queryLinksFrom(`rel-from-${i}`);
        expect(links).toHaveLength(1);
        expect(links[0].rel).toBe(rels[i]);
      }
    });
  });

  describe('archiveOlderThan', () => {
    it('deletes events older than N days', () => {
      const now = Date.now();
      const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;

      insertEvent(makeEvent({ id: 'old', ts: tenDaysAgo - 1000, team_id: 'team-arch' }));
      insertEvent(makeEvent({ id: 'recent', ts: now, team_id: 'team-arch' }));

      const deleted = archiveOlderThan(5);
      expect(deleted).toBe(1);

      const remaining = queryByTeam('team-arch');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe('recent');
    });

    it('also removes orphaned links', () => {
      const now = Date.now();
      const old = now - 10 * 24 * 60 * 60 * 1000;

      insertEvent(makeEvent({ id: 'old-linked', ts: old - 1000 }));
      insertEvent(makeEvent({ id: 'new-linked', ts: now }));
      insertLink({ from_event_id: 'old-linked', to_event_id: 'new-linked', rel: 'caused_by' });

      archiveOlderThan(5);

      const links = queryLinksTo('new-linked');
      expect(links).toHaveLength(0);
    });

    it('returns 0 when nothing to archive', () => {
      insertEvent(makeEvent({ id: 'fresh', ts: Date.now() }));
      const deleted = archiveOlderThan(1);
      expect(deleted).toBe(0);
    });
  });
});
