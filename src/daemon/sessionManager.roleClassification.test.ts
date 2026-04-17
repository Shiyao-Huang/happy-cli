import { describe, expect, it } from 'vitest';
import {
  EVALUABLE_ROLES,
  RESPAWN_PRIORITY_ROLES,
  isEvaluableRole,
  hasRespawnPriority,
} from './sessionManager';

describe('role classification (F-020)', () => {
  describe('EVALUABLE_ROLES', () => {
    it('contains supervisor and help-agent', () => {
      expect(EVALUABLE_ROLES.has('supervisor')).toBe(true);
      expect(EVALUABLE_ROLES.has('help-agent')).toBe(true);
    });

    it('does not contain mainline roles', () => {
      expect(EVALUABLE_ROLES.has('master')).toBe(false);
      expect(EVALUABLE_ROLES.has('implementer')).toBe(false);
      expect(EVALUABLE_ROLES.has('researcher')).toBe(false);
    });
  });

  describe('RESPAWN_PRIORITY_ROLES', () => {
    it('contains master', () => {
      expect(RESPAWN_PRIORITY_ROLES.has('master')).toBe(true);
    });

    it('does not contain evaluable roles', () => {
      expect(RESPAWN_PRIORITY_ROLES.has('supervisor')).toBe(false);
      expect(RESPAWN_PRIORITY_ROLES.has('help-agent')).toBe(false);
    });
  });

  describe('isEvaluableRole', () => {
    it('returns true for supervisor', () => {
      expect(isEvaluableRole('supervisor')).toBe(true);
    });

    it('returns true for help-agent', () => {
      expect(isEvaluableRole('help-agent')).toBe(true);
    });

    it('returns false for master', () => {
      expect(isEvaluableRole('master')).toBe(false);
    });

    it('returns false for implementer', () => {
      expect(isEvaluableRole('implementer')).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isEvaluableRole(undefined)).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isEvaluableRole('')).toBe(false);
    });
  });

  describe('hasRespawnPriority', () => {
    it('returns true for master', () => {
      expect(hasRespawnPriority('master')).toBe(true);
    });

    it('returns false for supervisor', () => {
      expect(hasRespawnPriority('supervisor')).toBe(false);
    });

    it('returns false for help-agent', () => {
      expect(hasRespawnPriority('help-agent')).toBe(false);
    });

    it('returns false for implementer', () => {
      expect(hasRespawnPriority('implementer')).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(hasRespawnPriority(undefined)).toBe(false);
    });
  });
});
