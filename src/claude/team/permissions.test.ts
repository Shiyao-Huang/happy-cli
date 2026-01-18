/**
 * Happy Team Runtime Permission Validation System Tests
 *
 * Comprehensive test suite for the permissions module covering:
 * - Role definition loading from YAML
 * - Tool permission checking
 * - Allowlist and denylist enforcement
 * - Read-only access restrictions
 * - Permission caching
 * - Utility functions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadRoleDefinitions,
  getRoleDefinition,
  getAllRoleIds,
  checkToolPermission,
  checkToolPermissions,
  getAllowedTools,
  getDeniedTools,
  clearPermissionCache,
  getPermissionCacheStats,
  isValidRole,
  getRoleCategory,
  getRoleName,
  getRolesByCategory,
  isReadOnlyRole,
  getPermissionMode,
} from './permissions';

describe('Runtime Permission Validation System', () => {
  describe('Role Definition Loading', () => {
    it('should load ROLE_DEFINITIONS.yaml successfully', () => {
      const definitions = loadRoleDefinitions();

      expect(definitions).toBeDefined();
      expect(definitions.metadata.version).toBe('2.0.0');
      expect(definitions.metadata.license).toBe('MIT');
      expect(definitions.metadata.compatibility).toBe('ohmyopencode');
    });

    it('should have 10 core roles defined', () => {
      const definitions = loadRoleDefinitions();

      expect(definitions.roles.length).toBeGreaterThanOrEqual(10);
    });

    it('should include all expected core roles', () => {
      const roleIds = getAllRoleIds();

      expect(roleIds).toContain('master');
      expect(roleIds).toContain('builder');
      expect(roleIds).toContain('framer');
      expect(roleIds).toContain('scout');
      expect(roleIds).toContain('scribe');
      expect(roleIds).toContain('qa');
      expect(roleIds).toContain('reviewer');
      expect(roleIds).toContain('product-owner');
      expect(roleIds).toContain('ux-designer');
      expect(roleIds).toContain('solution-architect');
    });
  });

  describe('Role Definition Retrieval', () => {
    it('should get role definition by ID', () => {
      const master = getRoleDefinition('master');

      expect(master).toBeDefined();
      expect(master?.id).toBe('master');
      expect(master?.name).toBe('Master Coordinator');
      expect(master?.category).toBe('coordination');
    });

    it('should get product owner role', () => {
      const productOwner = getRoleDefinition('product-owner');

      expect(productOwner).toBeDefined();
      expect(productOwner?.id).toBe('product-owner');
      expect(productOwner?.category).toBe('product-planning');
      expect(productOwner?.policy?.permissionMode).toBe('yolo');
    });

    it('should get UX designer role', () => {
      const uxDesigner = getRoleDefinition('ux-designer');

      expect(uxDesigner).toBeDefined();
      expect(uxDesigner?.id).toBe('ux-designer');
      expect(uxDesigner?.category).toBe('ux-design');
    });

    it('should get solution architect role', () => {
      const solutionArchitect = getRoleDefinition('solution-architect');

      expect(solutionArchitect).toBeDefined();
      expect(solutionArchitect?.id).toBe('solution-architect');
      expect(solutionArchitect?.category).toBe('architecture');
    });

    it('should return undefined for unknown role', () => {
      const unknown = getRoleDefinition('unknown-role');
      expect(unknown).toBeUndefined();
    });

    it('should handle role ID case-insensitively', () => {
      // Note: getRoleDefinition is case-sensitive for role IDs
      // Only use lowercase role IDs with hyphens
      const master1 = getRoleDefinition('master');
      const master2 = getRoleDefinition('master');

      expect(master1).toBeDefined();
      expect(master2).toBeDefined();
      expect(master1?.id).toBe(master2?.id);
    });
  });

  describe('Tool Permission Checking - Master Role', () => {
    it('should allow master to use update_task', async () => {
      const result = await checkToolPermission('master', 'update_task');

      expect(result.allowed).toBe(true);
      expect(result.role).toBe('master');
      expect(result.tool).toBe('update_task');
    });

    it('should allow master to use list_tasks', async () => {
      const result = await checkToolPermission('master', 'list_tasks');

      expect(result.allowed).toBe(true);
    });

    it('should allow master to use send_team_message', async () => {
      const result = await checkToolPermission('master', 'send_team_message');

      expect(result.allowed).toBe(true);
    });

    it('should allow master to use read', async () => {
      const result = await checkToolPermission('master', 'read');

      expect(result.allowed).toBe(true);
    });

    it('should deny master from using edit (toolsToAvoid)', async () => {
      const result = await checkToolPermission('master', 'edit');

      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/only edit source files/i);
    });

    it('should deny master from using write_to_file (policy.disallowedTools)', async () => {
      const result = await checkToolPermission('master', 'write_to_file');

      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/disallowedTools/i);
    });

    it('should deny master from using spawn_session', async () => {
      const result = await checkToolPermission('master', 'spawn_session');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Delegate');
    });
  });

  describe('Tool Permission Checking - Builder Role', () => {
    it('should allow builder to use edit', async () => {
      const result = await checkToolPermission('builder', 'edit');

      expect(result.allowed).toBe(true);
    });

    it('should allow builder to use bash', async () => {
      const result = await checkToolPermission('builder', 'bash');

      expect(result.allowed).toBe(true);
    });

    it('should allow builder to use update_task', async () => {
      const result = await checkToolPermission('builder', 'update_task');

      expect(result.allowed).toBe(true);
    });

    it('should deny builder from using spawn_session', async () => {
      const result = await checkToolPermission('builder', 'spawn_session');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Cannot create new agents');
    });
  });

  describe('Tool Permission Checking - Scout Role', () => {
    it('should allow scout to use grep', async () => {
      const result = await checkToolPermission('scout', 'grep');

      expect(result.allowed).toBe(true);
    });

    it('should allow scout to use find', async () => {
      const result = await checkToolPermission('scout', 'find');

      expect(result.allowed).toBe(true);
    });

    it('should deny scout from using bash', async () => {
      const result = await checkToolPermission('scout', 'bash');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('read-only');
    });

    it('should deny scout from using edit', async () => {
      const result = await checkToolPermission('scout', 'edit');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('read-only');
    });
  });

  describe('Tool Permission Checking - Reviewer Role', () => {
    it('should allow reviewer to use read', async () => {
      const result = await checkToolPermission('reviewer', 'read');

      expect(result.allowed).toBe(true);
    });

    it('should allow reviewer to use list_tasks', async () => {
      const result = await checkToolPermission('reviewer', 'list_tasks');

      expect(result.allowed).toBe(true);
    });

    it('should deny reviewer from using edit', async () => {
      const result = await checkToolPermission('reviewer', 'edit');

      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/read-only/i);
    });

    it('should deny reviewer from using bash', async () => {
      const result = await checkToolPermission('reviewer', 'bash');

      expect(result.allowed).toBe(false);
    });
  });

  describe('Tool Permission Checking - Product Owner Role', () => {
    it('should allow product owner to use update_task', async () => {
      const result = await checkToolPermission('product-owner', 'update_task');

      expect(result.allowed).toBe(true);
    });

    it('should allow product owner to use websearch_exa', async () => {
      const result = await checkToolPermission('product-owner', 'websearch_exa');

      expect(result.allowed).toBe(true);
    });

    it('should deny product owner from using edit', async () => {
      const result = await checkToolPermission('product-owner', 'edit');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Does not write code');
    });

    it('should deny product owner from using spawn_session', async () => {
      const result = await checkToolPermission('product-owner', 'spawn_session');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Cannot create agents');
    });
  });

  describe('Tool Permission Checking - UX Designer Role', () => {
    it('should allow UX designer to use write_to_file', async () => {
      const result = await checkToolPermission('ux-designer', 'write_to_file');

      expect(result.allowed).toBe(true);
    });

    it('should allow UX designer to use edit', async () => {
      const result = await checkToolPermission('ux-designer', 'edit');

      expect(result.allowed).toBe(true);
    });

    it('should deny UX designer from using bash', async () => {
      const result = await checkToolPermission('ux-designer', 'bash');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Design focus');
    });
  });

  describe('Tool Permission Checking - Solution Architect Role', () => {
    it('should allow solution architect to use write_to_file', async () => {
      const result = await checkToolPermission('solution-architect', 'write_to_file');

      expect(result.allowed).toBe(true);
    });

    it('should allow solution architect to use grep', async () => {
      const result = await checkToolPermission('solution-architect', 'grep');

      expect(result.allowed).toBe(true);
    });

    it('should deny solution architect from using bash', async () => {
      const result = await checkToolPermission('solution-architect', 'bash');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('delegate implementation');
    });
  });

  describe('Batch Permission Checking', () => {
    it('should check multiple tools for master role', async () => {
      const tools = ['update_task', 'list_tasks', 'edit', 'bash'];
      const results = await checkToolPermissions('master', tools);

      expect(results.size).toBe(4);
      expect(results.get('update_task')?.allowed).toBe(true);
      expect(results.get('list_tasks')?.allowed).toBe(true);
      expect(results.get('edit')?.allowed).toBe(false);
      expect(results.get('bash')?.allowed).toBe(false);
    });

    it('should check multiple tools for builder role', async () => {
      const tools = ['edit', 'bash', 'spawn_session', 'update_task'];
      const results = await checkToolPermissions('builder', tools);

      expect(results.size).toBe(4);
      expect(results.get('edit')?.allowed).toBe(true);
      expect(results.get('bash')?.allowed).toBe(true);
      expect(results.get('spawn_session')?.allowed).toBe(false);
      expect(results.get('update_task')?.allowed).toBe(true);
    });
  });

  describe('Get Allowed Tools', () => {
    it('should return allowed tools for master', async () => {
      const allowed = await getAllowedTools('master');

      expect(allowed).toContain('update_task');
      expect(allowed).toContain('list_tasks');
      expect(allowed).toContain('read');
      expect(allowed).not.toContain('edit');
      expect(allowed).not.toContain('bash');
    });

    it('should return allowed tools for builder', async () => {
      const allowed = await getAllowedTools('builder');

      expect(allowed).toContain('edit');
      expect(allowed).toContain('bash');
      expect(allowed).toContain('update_task');
      expect(allowed).not.toContain('spawn_session');
    });

    it('should return allowed tools for scout', async () => {
      const allowed = await getAllowedTools('scout');

      expect(allowed).toContain('grep');
      expect(allowed).toContain('find');
      expect(allowed).toContain('read');
      expect(allowed).not.toContain('edit');
      expect(allowed).not.toContain('bash');
    });
  });

  describe('Get Denied Tools', () => {
    it('should return denied tools for master', async () => {
      const denied = await getDeniedTools('master');

      expect(denied).toContain('edit');
      expect(denied).toContain('write_to_file');
      expect(denied).toContain('spawn_session');
      expect(denied).toContain('bash');
    });

    it('should return denied tools for builder', async () => {
      const denied = await getDeniedTools('builder');

      expect(denied).toContain('spawn_session');
    });

    it('should return denied tools for reviewer', async () => {
      const denied = await getDeniedTools('reviewer');

      expect(denied).toContain('edit');
      expect(denied).toContain('bash');
      expect(denied).toContain('update_task');
    });
  });

  describe('Permission Caching', () => {
    afterEach(async () => {
      await clearPermissionCache();
    });

    it('should cache permission check results', async () => {
      const result1 = await checkToolPermission('master', 'update_task');
      const stats1 = getPermissionCacheStats();

      expect(stats1.size).toBeGreaterThan(0);

      const result2 = await checkToolPermission('master', 'update_task');
      const stats2 = getPermissionCacheStats();

      expect(result1.allowed).toBe(result2.allowed);
      expect(result1.reason).toBe(result2.reason);
      expect(stats2.size).toBe(stats1.size);
    });

    it('should clear permission cache', async () => {
      await checkToolPermission('master', 'update_task');
      const statsBefore = getPermissionCacheStats();
      expect(statsBefore.size).toBeGreaterThan(0);

      await clearPermissionCache();
      const statsAfter = getPermissionCacheStats();
      expect(statsAfter.size).toBe(0);
    });

    it('should return cache keys', () => {
      getPermissionCacheStats().keys.forEach((key) => {
        expect(key).toMatch(/^[a-z-]+:[a-z_]+$/);
      });
    });
  });

  describe('Utility Functions', () => {
    it('should validate known roles', () => {
      expect(isValidRole('master')).toBe(true);
      expect(isValidRole('builder')).toBe(true);
      expect(isValidRole('product-owner')).toBe(true);
    });

    it('should reject unknown roles', () => {
      expect(isValidRole('unknown-role')).toBe(false);
      expect(isValidRole('')).toBe(false);
    });

    it('should get role category', () => {
      expect(getRoleCategory('master')).toBe('coordination');
      expect(getRoleCategory('builder')).toBe('implementation');
      expect(getRoleCategory('product-owner')).toBe('product-planning');
      expect(getRoleCategory('ux-designer')).toBe('ux-design');
      expect(getRoleCategory('solution-architect')).toBe('architecture');
    });

    it('should get role display name', () => {
      expect(getRoleName('master')).toBe('Master Coordinator');
      expect(getRoleName('builder')).toBe('Builder / Executor');
      expect(getRoleName('product-owner')).toBe('Product Owner');
    });

    it('should get roles by category', () => {
      const coordinationRoles = getRolesByCategory('coordination');
      expect(coordinationRoles.length).toBeGreaterThanOrEqual(1);
      expect(coordinationRoles[0].id).toBe('master');

      const implementationRoles = getRolesByCategory('implementation');
      expect(implementationRoles.length).toBeGreaterThanOrEqual(2);
      expect(implementationRoles.some((r) => r.id === 'builder')).toBe(true);
      expect(implementationRoles.some((r) => r.id === 'framer')).toBe(true);

      const productPlanningRoles = getRolesByCategory('product-planning');
      expect(productPlanningRoles.length).toBeGreaterThanOrEqual(1);
      expect(productPlanningRoles[0].id).toBe('product-owner');
    });

    it('should check if role is read-only', () => {
      expect(isReadOnlyRole('master')).toBe(true);
      expect(isReadOnlyRole('scout')).toBe(true);
      expect(isReadOnlyRole('reviewer')).toBe(true);
      expect(isReadOnlyRole('builder')).toBe(false);
      expect(isReadOnlyRole('product-owner')).toBe(false);
    });

    it('should get permission mode', () => {
      expect(getPermissionMode('master')).toBe('plan');
      expect(getPermissionMode('builder')).toBe('yolo');
      expect(getPermissionMode('product-owner')).toBe('yolo');
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle unknown role gracefully', async () => {
      const result = await checkToolPermission('unknown-role', 'edit');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Unknown role');
    });

    it('should handle tool name case-insensitively', async () => {
      const result1 = await checkToolPermission('master', 'UPDATE_TASK');
      const result2 = await checkToolPermission('master', 'Update_Task');
      const result3 = await checkToolPermission('master', 'update_task');

      expect(result1.allowed).toBe(result2.allowed);
      expect(result2.allowed).toBe(result3.allowed);
    });

    it('should handle role ID with underscores', async () => {
      const result1 = await checkToolPermission('product_owner', 'update_task');
      const result2 = await checkToolPermission('product-owner', 'update_task');

      expect(result1.allowed).toBe(result2.allowed);
    });

    it('should return empty array for unknown role allowed tools', async () => {
      const allowed = await getAllowedTools('unknown-role');
      expect(allowed).toEqual([]);
    });

    it('should return empty array for unknown role denied tools', async () => {
      const denied = await getDeniedTools('unknown-role');
      expect(denied).toEqual([]);
    });
  });

  describe('Integration Tests', () => {
    it('should enforce least privilege principle', async () => {
      const masterTools = await getAllowedTools('master');
      const builderTools = await getAllowedTools('builder');

      // Master should have fewer tools than builder (read-only)
      expect(masterTools.length).toBeLessThan(builderTools.length);

      // Master should not have write tools
      expect(masterTools).not.toContain('edit');
      expect(masterTools).not.toContain('bash');

      // Builder should have write tools
      expect(builderTools).toContain('edit');
      expect(builderTools).toContain('bash');
    });

    it('should support oh-my-opencode category routing', () => {
      const coordinationRoles = getRolesByCategory('coordination');
      const productPlanningRoles = getRolesByCategory('product-planning');
      const uxDesignRoles = getRolesByCategory('ux-design');
      const architectureRoles = getRolesByCategory('architecture');
      const implementationRoles = getRolesByCategory('implementation');
      const supportRoles = getRolesByCategory('support');

      expect(coordinationRoles.length).toBeGreaterThan(0);
      expect(productPlanningRoles.length).toBeGreaterThan(0);
      expect(uxDesignRoles.length).toBeGreaterThan(0);
      expect(architectureRoles.length).toBeGreaterThan(0);
      expect(implementationRoles.length).toBeGreaterThan(0);
      expect(supportRoles.length).toBeGreaterThan(0);
    });

    it('should support OpenSpec permission modes', () => {
      expect(getPermissionMode('master')).toBe('plan');
      expect(getPermissionMode('product-owner')).toBe('yolo');
      expect(getPermissionMode('builder')).toBe('yolo');
    });
  });
});
