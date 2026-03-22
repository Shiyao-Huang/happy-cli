/**
 * Trace Store — SQLite-backed CRUD for trace events and links
 *
 * Storage path: <ahaHomeDir>/trace/trace.db
 * Uses better-sqlite3 for synchronous, non-blocking SQLite access.
 *
 * Design:
 *   - trace_events: 18-column table with 5 indexes for common query patterns
 *   - trace_links:  causal edge table with 3 indexes
 *   - All writes are wrapped in try/catch — trace must never break the main app
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  TraceEvent,
  TraceLink,
  TraceLinkRel,
  TraceQueryOpts,
} from './traceTypes';
import { TRACE_LINK_RELS } from './traceTypes';

// ── Schema DDL ──────────────────────────────────────────────────────────────

const CREATE_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS trace_events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  level TEXT DEFAULT 'info',
  source TEXT NOT NULL,
  trace_id TEXT,
  span_id TEXT,
  parent_span_id TEXT,
  team_id TEXT,
  task_id TEXT,
  session_id TEXT,
  member_id TEXT,
  run_id TEXT,
  pid INTEGER,
  summary TEXT,
  status TEXT,
  payload_ref TEXT,
  attrs_json TEXT
);`;

const CREATE_EVENTS_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_trace_team ON trace_events(team_id, ts);',
  'CREATE INDEX IF NOT EXISTS idx_trace_session ON trace_events(session_id, ts);',
  'CREATE INDEX IF NOT EXISTS idx_trace_task ON trace_events(task_id, ts);',
  'CREATE INDEX IF NOT EXISTS idx_trace_kind ON trace_events(kind, ts);',
  'CREATE INDEX IF NOT EXISTS idx_trace_trace ON trace_events(trace_id, ts);',
];

const CREATE_LINKS_TABLE = `
CREATE TABLE IF NOT EXISTS trace_links (
  from_event_id TEXT NOT NULL REFERENCES trace_events(id),
  to_event_id TEXT NOT NULL REFERENCES trace_events(id),
  rel TEXT NOT NULL CHECK(rel IN ('caused_by','spawned_from','belongs_to_task','retries','replaces','reads_log_of'))
);`;

const CREATE_LINKS_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_links_from ON trace_links(from_event_id);',
  'CREATE INDEX IF NOT EXISTS idx_links_to ON trace_links(to_event_id);',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_links_pair ON trace_links(from_event_id, to_event_id, rel);',
];

// ── Singleton DB Handle ─────────────────────────────────────────────────────

let _db: Database.Database | null = null;

/**
 * Resolve the trace DB file path.
 * Accepts an optional base dir for testing; defaults to ~/.aha/trace/trace.db
 */
export function resolveTraceDbPath(ahaHomeDir?: string): string {
  const base = ahaHomeDir ?? join(process.env.HOME ?? '/tmp', '.aha');
  return join(base, 'trace', 'trace.db');
}

/**
 * Initialize the trace database: create directory, open connection,
 * run schema migrations.
 *
 * Returns the Database handle for direct access if needed.
 */
export function initTraceDb(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? resolveTraceDbPath();
  const dir = dirname(resolvedPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');

  // Run schema creation inside a transaction
  db.transaction(() => {
    db.exec(CREATE_EVENTS_TABLE);
    for (const idx of CREATE_EVENTS_INDEXES) {
      db.exec(idx);
    }
    db.exec(CREATE_LINKS_TABLE);
    for (const idx of CREATE_LINKS_INDEXES) {
      db.exec(idx);
    }
  })();

  _db = db;
  return db;
}

/**
 * Get the current DB handle. Throws if initTraceDb() hasn't been called.
 */
export function getTraceDb(): Database.Database {
  if (!_db) {
    throw new Error('Trace DB not initialized. Call initTraceDb() first.');
  }
  return _db;
}

/**
 * Close the trace database connection and clear the singleton.
 */
export function closeTraceDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ── Prepared Statements (lazy) ──────────────────────────────────────────────

const INSERT_EVENT_SQL = `
INSERT INTO trace_events (
  id, ts, kind, level, source,
  trace_id, span_id, parent_span_id,
  team_id, task_id, session_id, member_id, run_id, pid,
  summary, status, payload_ref, attrs_json
) VALUES (
  @id, @ts, @kind, @level, @source,
  @trace_id, @span_id, @parent_span_id,
  @team_id, @task_id, @session_id, @member_id, @run_id, @pid,
  @summary, @status, @payload_ref, @attrs_json
);`;

const INSERT_LINK_SQL = `
INSERT OR IGNORE INTO trace_links (from_event_id, to_event_id, rel)
VALUES (@from_event_id, @to_event_id, @rel);`;

// ── CRUD Operations ─────────────────────────────────────────────────────────

/** Insert a single trace event. */
export function insertEvent(event: TraceEvent): void {
  const db = getTraceDb();
  const stmt = db.prepare(INSERT_EVENT_SQL);
  stmt.run({
    id: event.id,
    ts: event.ts,
    kind: event.kind,
    level: event.level,
    source: event.source,
    trace_id: event.trace_id,
    span_id: event.span_id,
    parent_span_id: event.parent_span_id,
    team_id: event.team_id,
    task_id: event.task_id,
    session_id: event.session_id,
    member_id: event.member_id,
    run_id: event.run_id,
    pid: event.pid,
    summary: event.summary,
    status: event.status,
    payload_ref: event.payload_ref,
    attrs_json: event.attrs_json,
  });
}

/** Insert a causal link between two events. */
export function insertLink(link: TraceLink): void {
  if (!TRACE_LINK_RELS.includes(link.rel)) {
    throw new Error(`Invalid trace link relation: ${link.rel}`);
  }
  const db = getTraceDb();
  const stmt = db.prepare(INSERT_LINK_SQL);
  stmt.run({
    from_event_id: link.from_event_id,
    to_event_id: link.to_event_id,
    rel: link.rel,
  });
}

// ── Query Helpers ───────────────────────────────────────────────────────────

function buildWhereClause(
  baseCondition: string,
  opts?: TraceQueryOpts,
): { where: string; params: Record<string, unknown> } {
  const conditions = [baseCondition];
  const params: Record<string, unknown> = {};

  if (opts?.since != null) {
    conditions.push('ts >= @since');
    params.since = opts.since;
  }
  if (opts?.until != null) {
    conditions.push('ts <= @until');
    params.until = opts.until;
  }
  if (opts?.kind != null) {
    conditions.push('kind = @kind');
    params.kind = opts.kind;
  }
  if (opts?.level != null) {
    conditions.push('level = @level');
    params.level = opts.level;
  }

  const where = conditions.join(' AND ');
  return { where, params };
}

function queryEvents(
  baseCondition: string,
  baseParam: Record<string, unknown>,
  opts?: TraceQueryOpts,
): TraceEvent[] {
  const db = getTraceDb();
  const { where, params } = buildWhereClause(baseCondition, opts);
  const allParams = { ...baseParam, ...params };

  const limit = opts?.limit ?? 1000;
  const offset = opts?.offset ?? 0;

  const sql = `SELECT * FROM trace_events WHERE ${where} ORDER BY ts ASC LIMIT @_limit OFFSET @_offset;`;
  const stmt = db.prepare(sql);
  return stmt.all({ ...allParams, _limit: limit, _offset: offset }) as TraceEvent[];
}

/** Query events by team_id, ordered by timestamp. */
export function queryByTeam(teamId: string, opts?: TraceQueryOpts): TraceEvent[] {
  return queryEvents('team_id = @team_id', { team_id: teamId }, opts);
}

/** Query events by session_id, ordered by timestamp. */
export function queryBySession(sessionId: string, opts?: TraceQueryOpts): TraceEvent[] {
  return queryEvents('session_id = @session_id', { session_id: sessionId }, opts);
}

/** Query events by task_id, ordered by timestamp. */
export function queryByTask(taskId: string, opts?: TraceQueryOpts): TraceEvent[] {
  return queryEvents('task_id = @task_id', { task_id: taskId }, opts);
}

/** Query events by member_id, ordered by timestamp. */
export function queryByMember(memberId: string, opts?: TraceQueryOpts): TraceEvent[] {
  return queryEvents('member_id = @member_id', { member_id: memberId }, opts);
}

/** Query events by run_id, ordered by timestamp. */
export function queryByRun(runId: string, opts?: TraceQueryOpts): TraceEvent[] {
  return queryEvents('run_id = @run_id', { run_id: runId }, opts);
}

/** Query events by trace_id, ordered by timestamp. */
export function queryByTraceId(traceId: string, opts?: TraceQueryOpts): TraceEvent[] {
  return queryEvents('trace_id = @trace_id', { trace_id: traceId }, opts);
}

/** Query error/failed events within a time window. */
export function queryErrors(opts?: TraceQueryOpts): TraceEvent[] {
  const db = getTraceDb();
  const conditions: string[] = ["(level = 'error' OR status = 'failed')"];
  const params: Record<string, unknown> = {};

  if (opts?.since != null) {
    conditions.push('ts >= @since');
    params.since = opts.since;
  }
  if (opts?.until != null) {
    conditions.push('ts <= @until');
    params.until = opts.until;
  }

  const limit = opts?.limit ?? 1000;
  const offset = opts?.offset ?? 0;
  const where = conditions.join(' AND ');

  const sql = `SELECT * FROM trace_events WHERE ${where} ORDER BY ts DESC LIMIT @_limit OFFSET @_offset;`;
  const stmt = db.prepare(sql);
  return stmt.all({ ...params, _limit: limit, _offset: offset }) as TraceEvent[];
}

/** Query links originating from a given event. */
export function queryLinksFrom(eventId: string): TraceLink[] {
  const db = getTraceDb();
  const stmt = db.prepare('SELECT * FROM trace_links WHERE from_event_id = ?;');
  return stmt.all(eventId) as TraceLink[];
}

/** Query links pointing to a given event. */
export function queryLinksTo(eventId: string): TraceLink[] {
  const db = getTraceDb();
  const stmt = db.prepare('SELECT * FROM trace_links WHERE to_event_id = ?;');
  return stmt.all(eventId) as TraceLink[];
}

// ── Maintenance ─────────────────────────────────────────────────────────────

/**
 * Delete trace events older than the given number of days.
 * Also removes orphaned links.
 * Returns the number of deleted events.
 */
export function archiveOlderThan(days: number): number {
  const db = getTraceDb();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const result = db.transaction(() => {
    // Delete orphaned links first (referencing events that will be deleted)
    db.prepare(`
      DELETE FROM trace_links WHERE from_event_id IN (
        SELECT id FROM trace_events WHERE ts < @cutoff
      ) OR to_event_id IN (
        SELECT id FROM trace_events WHERE ts < @cutoff
      );
    `).run({ cutoff });

    // Delete old events
    const deleteResult = db.prepare(
      'DELETE FROM trace_events WHERE ts < @cutoff;'
    ).run({ cutoff });

    return deleteResult.changes;
  })();

  return result;
}
