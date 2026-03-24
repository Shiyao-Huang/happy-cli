/**
 * Trace Emitter — High-level API for emitting trace events and links
 *
 * All operations are wrapped in try/catch: trace failures must NEVER
 * break the main application flow. Errors are logged to stderr and
 * silently swallowed.
 */

import type {
  PayloadRef,
  TraceEvent,
  TraceEventIds,
  TraceLevel,
  TraceLink,
  TraceLinkRel,
} from './traceTypes';
import { TraceEventKind, TRACE_EVENT_KINDS, TRACE_LINK_RELS } from './traceTypes';
import { generateTraceId, getTraceContext } from './traceId';
import { initTraceDb, insertEvent, insertLink } from './traceStore';

// ── Lazy DB Initialization ────────────────────────────────────────────────
let _dbInitialized = false;

/** Ensure the trace DB is initialized before any write. Idempotent and safe. */
function ensureTraceDb(): void {
  if (_dbInitialized) return;
  try {
    initTraceDb();
    _dbInitialized = true;
  } catch {
    // If initialization fails, we'll get an error on the next insertEvent
    // call which is already caught by emitTraceEvent's try/catch.
  }
}

/**
 * Emit a structured trace event.
 *
 * @param kind    - One of the 25 TraceEventKind values
 * @param source  - Subsystem emitting the event (e.g. "daemon", "mcp")
 * @param ids     - Correlation and entity IDs
 * @param summary - Human-readable one-liner (max ~300 chars)
 * @param opts    - Optional: level, status, payloadRef, attrs
 * @returns The generated event ID, or null if emission failed
 */
export function emitTraceEvent(
  kind: TraceEventKind,
  source: string,
  ids: TraceEventIds,
  summary: string,
  opts?: {
    level?: TraceLevel;
    status?: string;
    payloadRef?: PayloadRef;
    attrs?: Record<string, unknown>;
  },
): string | null {
  try {
    ensureTraceDb();

    // Validate kind
    if (!TRACE_EVENT_KINDS.includes(kind)) {
      throw new Error(`Invalid trace event kind: ${kind}`);
    }

    const eventId = generateTraceId();
    const traceId = ids.trace_id ?? getTraceContext();

    const event: TraceEvent = {
      id: eventId,
      ts: Date.now(),
      kind,
      level: opts?.level ?? 'info',
      source,

      trace_id: traceId,
      span_id: ids.span_id ?? eventId,
      parent_span_id: ids.parent_span_id ?? null,

      team_id: ids.team_id ?? null,
      task_id: ids.task_id ?? null,
      session_id: ids.session_id ?? null,
      member_id: ids.member_id ?? null,
      run_id: ids.run_id ?? null,
      pid: ids.pid ?? process.pid,

      summary: summary.slice(0, 300),
      status: opts?.status ?? null,
      payload_ref: opts?.payloadRef ? JSON.stringify(opts.payloadRef) : null,
      attrs_json: opts?.attrs ? JSON.stringify(opts.attrs) : null,
    };

    insertEvent(event);
    return eventId;
  } catch (err) {
    // Trace must never break the main flow
    process.stderr.write(
      `[trace] emitTraceEvent failed (kind=${kind}): ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
}

/**
 * Emit a causal link between two trace events.
 *
 * @param fromId - Source event ID
 * @param toId   - Target event ID
 * @param rel    - Relationship type
 * @returns true if the link was written, false on failure
 */
export function emitTraceLink(
  fromId: string,
  toId: string,
  rel: TraceLinkRel,
): boolean {
  try {
    ensureTraceDb();

    if (!TRACE_LINK_RELS.includes(rel)) {
      throw new Error(`Invalid trace link relation: ${rel}`);
    }

    const link: TraceLink = {
      from_event_id: fromId,
      to_event_id: toId,
      rel,
    };

    insertLink(link);
    return true;
  } catch (err) {
    process.stderr.write(
      `[trace] emitTraceLink failed (${fromId} -[${rel}]-> ${toId}): ${err instanceof Error ? err.message : String(err)}\n`
    );
    return false;
  }
}

/**
 * Build a PayloadRef pointing to a specific location in a log file.
 */
export function buildPayloadRef(
  source: string,
  path: string,
  offset?: number,
  length?: number,
): PayloadRef {
  const ref: PayloadRef = { source, path };
  if (offset != null) ref.offset = offset;
  if (length != null) ref.length = length;
  return ref;
}
