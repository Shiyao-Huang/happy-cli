import { describe, it, expect } from 'vitest';
import {
    canCreateTeamTasks,
    canManageExistingTasks,
    canSpawnAgents,
    generateRolePrompt,
    getRolePermissions,
    isBootstrapRole,
    isCoordinatorRole
} from './roles';

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

        it('should restrict spawn_session for builder role', () => {
            const result = getRolePermissions('builder', undefined);

            expect(result.permissionMode).toBe('default');
            expect(result.disallowedTools.some((tool) => tool.startsWith('spawn_session'))).toBe(true);
        });

        it('should restrict spawn_session for framer role', () => {
            const result = getRolePermissions('framer', undefined);

            expect(result.permissionMode).toBe('default');
            expect(result.disallowedTools.some((tool) => tool.startsWith('spawn_session'))).toBe(true);
        });

        it('should handle unknown roles gracefully', () => {
            const result = getRolePermissions('unknown-role', undefined);

            expect(result.permissionMode).toBe('default');
            expect(result.disallowedTools).toEqual([]);
        });
    });

    describe('role behavior helpers', () => {
        it('should detect org-manager as bootstrap role', () => {
            expect(isBootstrapRole('org-manager')).toBe(true);
        });

        it('should detect master as coordinator role', () => {
            expect(isCoordinatorRole('master')).toBe(true);
        });

        it('should allow org-manager to spawn agents and create tasks', () => {
            expect(canSpawnAgents('org-manager')).toBe(true);
            expect(canCreateTeamTasks('org-manager')).toBe(true);
            expect(canManageExistingTasks('org-manager')).toBe(true);
        });

        it('should inject live system state steps into the org-manager prompt', () => {
            const prompt = generateRolePrompt({
                teamId: 'team-123',
                role: 'org-manager',
            } as any);

            expect(prompt).toContain('get_team_info()');
            expect(prompt).toContain('list_tasks()');
            expect(prompt).toContain('You must use the actual live system state');
            expect(prompt).toContain('marketplace as a memory warehouse');
        });
    });
});
