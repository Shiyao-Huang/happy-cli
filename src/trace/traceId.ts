/**
 * Trace ID Generation & Propagation
 *
 * Generates ULID-based trace IDs and propagates them to child processes
 * via the AHA_TRACE_ID environment variable.
 */

import { ulid } from 'ulid';

const AHA_TRACE_ID_ENV = 'AHA_TRACE_ID';

/** Generate a new ULID-based trace ID. */
export function generateTraceId(): string {
  return ulid();
}

/**
 * Get the current trace context.
 * Reads AHA_TRACE_ID from env; if absent, generates a new one.
 */
export function getTraceContext(): string {
  const existing = process.env[AHA_TRACE_ID_ENV];
  if (existing && existing.length > 0) {
    return existing;
  }
  return generateTraceId();
}

/**
 * Set AHA_TRACE_ID in the current process environment so child processes
 * inherit it automatically.
 */
export function propagateTraceId(traceId: string): void {
  process.env[AHA_TRACE_ID_ENV] = traceId;
}
