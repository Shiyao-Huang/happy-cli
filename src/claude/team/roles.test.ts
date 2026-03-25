import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildAgentHandshakeContent,
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
    afterEach(() => {
        vi.unstubAllEnvs();
    });

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

        it('should return empty disallowed tools when role not in DEFAULT_ROLES (genome-first)', () => {
            // With genome-first architecture, DEFAULT_ROLES is empty.
            // Roles like 'scout'/'builder' are defined in GenomeSpec, not hardcoded.
            const result = getRolePermissions('scout', undefined);

            expect(result.permissionMode).toBe('default');
            expect(result.disallowedTools).toEqual([]);
        });

        it('should return empty disallowed tools for builder when not in DEFAULT_ROLES', () => {
            const result = getRolePermissions('builder', undefined);

            expect(result.permissionMode).toBe('default');
            // No hardcoded restrictions — permissions come from GenomeSpec at runtime
            expect(result.disallowedTools).toEqual([]);
        });

        it('should return empty disallowed tools for framer when not in DEFAULT_ROLES', () => {
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

        it('should honor authority overlays for task creation and management', () => {
            const genome = { authorities: ['task.create', 'task.update.any'] } as any;

            expect(canCreateTeamTasks('scribe', genome)).toBe(true);
            expect(canManageExistingTasks('scribe', genome)).toBe(true);
        });

        it('should honor authority overlays for agent spawning', () => {
            const genome = { authorities: ['agent.spawn'] } as any;

            expect(canSpawnAgents('scribe', genome)).toBe(true);
        });

        it('should allow supervisor to spawn agents when the genome explicitly enables recovery spawning', () => {
            const supervisorGenome = {
                authorities: ['agent.spawn'],
                behavior: { canSpawnAgents: true },
            } as any;

            expect(canSpawnAgents('supervisor', supervisorGenome)).toBe(true);
        });

        it('regression: master with canSpawnAgents=false but authorities=[task.create] can create tasks AND spawn agents', () => {
            // Regression fix: master is a coordinator role and MUST be able to spawn agents
            // to manage team topology (e.g., spawn supervisor for scoring cycle).
            // Phase 1-3 proved that blocking master from spawning broke the entire
            // scoring pipeline — no supervisor could be created, scoring data was frozen.
            // Coordinator roles now always get canSpawnAgents=true regardless of genome flag.
            const masterGenome = {
                behavior: { canSpawnAgents: false },
                authorities: ['task.create', 'task.assign', 'task.update.any'],
            } as any;

            expect(canCreateTeamTasks('master', masterGenome)).toBe(true);
            expect(canSpawnAgents('master', masterGenome)).toBe(true);
        });

        it('regression: master with no genome at all falls back to coordinator role check', () => {
            // If genome is not loaded (null), fall through to isCoordinatorRole()
            expect(canCreateTeamTasks('master', null)).toBe(true);
            expect(canCreateTeamTasks('master', undefined)).toBe(true);
        });

        it('should inject live system state steps into the org-manager prompt', () => {
            const prompt = generateRolePrompt({
                teamId: 'team-123',
                role: 'org-manager',
            } as any);

            expect(prompt).toContain('get_team_info()');
            expect(prompt).toContain('list_tasks()');
            expect(prompt).toContain('You must use the actual live system state');
            expect(prompt).toContain('The marketplace is optional memory, not a blocking dependency');
        });

        it('should return empty prompt for worker roles without genome (genome-first)', () => {
            // In genome-first architecture, worker role prompts come from GenomeSpec.
            // Without a genome, generateRolePrompt returns '' for non-coordinator roles.
            const prompt = generateRolePrompt({
                teamId: 'team-123',
                role: 'builder',
            } as any);

            expect(prompt).toBe('');
        });

        it('should return empty prompt for coordinators without genome (genome-first)', () => {
            // 'master' is not in DEFAULT_ROLES, so generateRolePrompt returns ''
            // In production, coordinator prompts are built from GenomeSpec
            const prompt = generateRolePrompt({
                teamId: 'team-123',
                role: 'master',
            } as any);

            expect(prompt).toBe('');
        });

        it('should build a worker handshake with explicit help-lane awareness', () => {
            vi.stubEnv('AHA_AGENT_SCOPE_SUMMARY', 'Owned paths: src/; forbidden: AGENTS.md, SYSTEM.md');

            const handshake = buildAgentHandshakeContent({
                role: 'builder',
                responsibilities: ['Implement the scoped work'],
                scopeSummary: 'fallback scope summary that should not win over env',
            });

            expect(handshake).toContain('SYSTEM.md and AGENTS.md');
            expect(handshake).toContain('request_help');
            expect(handshake).toContain('@help');
            expect(handshake).toContain('Owned paths: src/');
        });

        it('should build a coordinator handshake with role-specific readiness language', () => {
            const handshake = buildAgentHandshakeContent({
                role: 'master',
                isCoordinator: true,
                roleDescription: 'Coordinate the team and assign work',
            });

            expect(handshake).toContain('reporting for duty');
            expect(handshake).toContain('Coordinate the team and assign work');
            expect(handshake).toContain('help lane');
        });
    });
});
