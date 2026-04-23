/**
 * Trace Infrastructure Type Definitions
 *
 * Defines the unified event model for aha-cli tracing.
 * Events are structured as "thin index + strong links" — trace stores
 * only key boundary events with payload references pointing back to
 * the original log sources.
 *
 * 6 event chains:
 *   spawn_chain   — agent lifecycle from request to handshake
 *   task_chain    — task creation through completion
 *   help_chain    — @help request to resolution
 *   score_chain   — supervisor scoring and feedback upload
 *   lifecycle_chain — daemon, auth, session housekeeping
 *   supervisor_chain — supervisor cycle boundaries
 *   http_chain    — outbound HTTP request outcomes
 */

// ── Event Kinds ─────────────────────────────────────────────────────────────

export enum TraceEventKind {
  // spawn_chain (5)
  spawn_requested = 'spawn_requested',
  spawn_started = 'spawn_started',
  process_started = 'process_started',
  session_registered = 'session_registered',
  handshake_sent = 'handshake_sent',

  // task_chain (4)
  task_created = 'task_created',
  task_started = 'task_started',
  task_blocked = 'task_blocked',
  task_completed = 'task_completed',

  // help_chain (3)
  help_requested = 'help_requested',
  help_agent_spawned = 'help_agent_spawned',
  help_resolved = 'help_resolved',

  // score_chain (3)
  score_started = 'score_started',
  score_completed = 'score_completed',
  feedback_uploaded = 'feedback_uploaded',

  // lifecycle_chain (7)
  daemon_started = 'daemon_started',
  daemon_error = 'daemon_error',
  auth_resolved = 'auth_resolved',
  auth_failed = 'auth_failed',
  session_compacted = 'session_compacted',
  session_archived = 'session_archived',
  agent_killed = 'agent_killed',

  // supervisor_chain (2)
  supervisor_cycle_started = 'supervisor_cycle_started',
  supervisor_cycle_completed = 'supervisor_cycle_completed',

  // http_chain (2)
  http_request_completed = 'http_request_completed',
  http_request_failed = 'http_request_failed',
}

/** All valid event kind string values */
export const TRACE_EVENT_KINDS = Object.values(TraceEventKind) as string[];

// ── Link Relations ──────────────────────────────────────────────────────────

export type TraceLinkRel =
  | 'caused_by'
  | 'spawned_from'
  | 'belongs_to_task'
  | 'retries'
  | 'replaces'
  | 'reads_log_of';

export const TRACE_LINK_RELS: TraceLinkRel[] = [
  'caused_by',
  'spawned_from',
  'belongs_to_task',
  'retries',
  'replaces',
  'reads_log_of',
];

// ── Trace Event Levels ──────────────────────────────────────────────────────

export type TraceLevel = 'debug' | 'info' | 'warn' | 'error';

// ── Payload Reference ───────────────────────────────────────────────────────

/** Pointer to the original log/artifact — trace never copies large payloads. */
export interface PayloadRef {
  /** Log source identifier, e.g. "team_messages", "daemon_log", "cc_log" */
  source: string;
  /** File path to the original log */
  path: string;
  /** Byte offset within the file (optional, for precise seeking) */
  offset?: number;
  /** Byte length of the referenced payload (optional) */
  length?: number;
}

// ── Trace Event ─────────────────────────────────────────────────────────────

export interface TraceEvent {
  /** ULID — globally unique, time-sortable */
  id: string;
  /** Unix timestamp in milliseconds */
  ts: number;
  /** Event classification */
  kind: TraceEventKind;
  /** Severity level */
  level: TraceLevel;
  /** Subsystem that emitted the event, e.g. "daemon", "mcp", "runClaude" */
  source: string;

  // ── Correlation IDs ───────────────────────────────────────────────
  /** Root trace ID — links an entire causal chain */
  trace_id: string | null;
  /** Span ID — identifies this specific span */
  span_id: string | null;
  /** Parent span ID — for nested spans */
  parent_span_id: string | null;

  // ── Entity IDs ────────────────────────────────────────────────────
  /** Team identifier */
  team_id: string | null;
  /** Task identifier */
  task_id: string | null;
  /** Claude/Codex session identifier */
  session_id: string | null;
  /** Team member identifier */
  member_id: string | null;
  /** Daemon run identifier */
  run_id: string | null;
  /** OS process ID */
  pid: number | null;

  // ── Content ───────────────────────────────────────────────────────
  /** Human-readable one-liner (max ~300 chars) */
  summary: string | null;
  /** Outcome status, e.g. "ok", "failed", "timeout" */
  status: string | null;
  /** JSON-serialized PayloadRef — pointer to full payload */
  payload_ref: string | null;
  /** JSON blob for sparse/ad-hoc attributes */
  attrs_json: string | null;
}

// ── Trace Link ──────────────────────────────────────────────────────────────

export interface TraceLink {
  /** Source event ID */
  from_event_id: string;
  /** Target event ID */
  to_event_id: string;
  /** Relationship type */
  rel: TraceLinkRel;
}

// ── Query Options ───────────────────────────────────────────────────────────

export interface TraceQueryOpts {
  /** Only return events after this timestamp (ms) */
  since?: number;
  /** Only return events before this timestamp (ms) */
  until?: number;
  /** Filter by event kind */
  kind?: TraceEventKind;
  /** Filter by level */
  level?: TraceLevel;
  /** Maximum number of events to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

// ── Convenience type for emitter IDs argument ───────────────────────────────

export interface TraceEventIds {
  trace_id?: string | null;
  span_id?: string | null;
  parent_span_id?: string | null;
  team_id?: string | null;
  task_id?: string | null;
  session_id?: string | null;
  member_id?: string | null;
  run_id?: string | null;
  pid?: number | null;
}
