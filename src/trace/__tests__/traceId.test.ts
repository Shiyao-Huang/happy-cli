/**
 * Tests for traceId module — ULID generation and context propagation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateTraceId, getTraceContext, propagateTraceId } from '../traceId';

describe('traceId', () => {
  const originalEnv = process.env.AHA_TRACE_ID;

  afterEach(() => {
    // Restore original env
    if (originalEnv !== undefined) {
      process.env.AHA_TRACE_ID = originalEnv;
    } else {
      delete process.env.AHA_TRACE_ID;
    }
  });

  describe('generateTraceId', () => {
    it('returns a string', () => {
      const id = generateTraceId();
      expect(typeof id).toBe('string');
    });

    it('returns a 26-character ULID', () => {
      const id = generateTraceId();
      // ULID is 26 characters, uppercase alphanumeric (Crockford Base32)
      expect(id).toHaveLength(26);
      expect(id).toMatch(/^[0-9A-Z]{26}$/);
    });

    it('generates unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateTraceId());
      }
      expect(ids.size).toBe(100);
    });

    it('generates time-sortable IDs', async () => {
      const id1 = generateTraceId();
      await new Promise((r) => setTimeout(r, 2));
      const id2 = generateTraceId();
      expect(id2 > id1).toBe(true);
    });
  });

  describe('getTraceContext', () => {
    it('returns env value when AHA_TRACE_ID is set', () => {
      process.env.AHA_TRACE_ID = 'TEST_TRACE_ID_123';
      expect(getTraceContext()).toBe('TEST_TRACE_ID_123');
    });

    it('generates a new ID when AHA_TRACE_ID is not set', () => {
      delete process.env.AHA_TRACE_ID;
      const ctx = getTraceContext();
      expect(ctx).toHaveLength(26);
      expect(ctx).toMatch(/^[0-9A-Z]{26}$/);
    });

    it('generates a new ID when AHA_TRACE_ID is empty string', () => {
      process.env.AHA_TRACE_ID = '';
      const ctx = getTraceContext();
      expect(ctx).toHaveLength(26);
    });
  });

  describe('propagateTraceId', () => {
    it('sets AHA_TRACE_ID in process.env', () => {
      propagateTraceId('MY_TRACE_ID');
      expect(process.env.AHA_TRACE_ID).toBe('MY_TRACE_ID');
    });

    it('overwrites existing AHA_TRACE_ID', () => {
      process.env.AHA_TRACE_ID = 'OLD_ID';
      propagateTraceId('NEW_ID');
      expect(process.env.AHA_TRACE_ID).toBe('NEW_ID');
    });
  });
});
