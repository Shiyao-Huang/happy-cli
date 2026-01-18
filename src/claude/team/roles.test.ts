import { describe, it, expect } from 'vitest';
import { getRolePermissions } from './roles';

/**
 * Unit tests for role permissions system
 *
 * These tests verify that the role-based permission system correctly
 * enforces access controls based on role definitions.
 */
describe('Role Permissions System', () => {
    describe('getRolePermissions', () => {
        it('should return default permissions for undefined role', () => {
            const result = getRolePermissions(undefined, undefined);

            expect(result.permissionMode).toBe('default');
            expect(result.disallowedTools).toEqual([]);
        });

        it('should respect bypassPermissions mode when requested', () => {
            const result = getRolePermissions('master', 'bypassPermissions');

            expect(result.permissionMode).toBe('bypassPermissions');
        });

        it('should return disallowed tools for read-only roles', () => {
            // Scout is a read-only role
            const result = getRolePermissions('scout', undefined);

            expect(result.permissionMode).toBe('default');
            expect(result.disallowedTools).toBeDefined();
            expect(result.disallowedTools.length).toBeGreaterThan(0);
        });

        it('should allow all tools for builder role', () => {
            const result = getRolePermissions('builder', undefined);

            expect(result.permissionMode).toBe('default');
            expect(result.disallowedTools).toEqual([]);
        });

        it('should allow all tools for framer role', () => {
            const result = getRolePermissions('framer', undefined);

            expect(result.permissionMode).toBe('default');
            expect(result.disallowedTools).toEqual([]);
        });

        it('should handle unknown roles gracefully', () => {
            const result = getRolePermissions('unknown-role', undefined);

            expect(result.permissionMode).toBe('default');
            expect(result.disallowedTools).toEqual([]);
        });
    });
});
