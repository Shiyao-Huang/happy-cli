/**
 * Happy Team Runtime Permission Validation System
 *
 * This module provides runtime validation of tool access based on role definitions
 * from ROLE_DEFINITIONS.yaml. It enforces the principle of least privilege and
 * ensures agents can only access tools appropriate for their role.
 *
 * Integration with ROLE_DEFINITIONS.yaml:
 * - Parses role definitions from YAML
 * - Validates tool access at runtime before tool execution
 * - Supports allowlists and denylists
 * - Enforces read-only vs full-access modes
 */

import { Mutex } from 'async-mutex';
import YAML from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { logger } from '@/ui/logger';

// =============================================================================
// Type Definitions
// =============================================================================

export interface ToolPermission {
  access: 'allow' | 'deny';
  description?: string;
}

export interface RoleDefinition {
  id: string;
  name: string;
  category: string;
  description?: string;
  capabilities: string[];
  tools?: ToolPermission[];
  toolsToAvoid?: Array<{
    name: string;
    reason: string;
  }>;
  policy?: {
    permissionMode?: 'plan' | 'yolo' | 'bypassPermissions' | 'acceptEdits' | 'read-only';
    accessLevel?: 'read-only' | 'full-access';
    disallowedTools?: string[];
  };
}

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
  role?: string;
  tool?: string;
}

export interface RoleDefinitions {
  metadata: {
    version: string;
    lastUpdated: string;
    schemaVersion: string;
    license: string;
    compatibility: string;
  };
  roles: RoleDefinition[];
  additionalRoles?: Array<{
    id: string;
    name: string;
    category: string;
    status: 'pending' | 'active';
  }>;
}

// =============================================================================
// Permission Cache & Mutex
// =============================================================================

const permissionCache = new Map<string, boolean>();
const cacheMutex = new Mutex();
let roleDefinitions: RoleDefinitions | null = null;

// =============================================================================
// ROLE_DEFINITIONS.yaml Loader
// =============================================================================

const ROLE_DEFINITIONS_PATH = path.join(
  __dirname,
  '../../../../happy-server/shared/role-definitions/ROLE_DEFINITIONS.yaml'
);

/**
 * Load and parse ROLE_DEFINITIONS.yaml
 */
export function loadRoleDefinitions(): RoleDefinitions {
  if (roleDefinitions) {
    return roleDefinitions;
  }

  try {
    const yamlContent = fs.readFileSync(ROLE_DEFINITIONS_PATH, 'utf8');
    roleDefinitions = YAML.load(yamlContent) as RoleDefinitions;

    logger.debug(`[Permissions] Loaded ROLE_DEFINITIONS.yaml v${roleDefinitions.metadata.version}`);
    logger.debug(`[Permissions] Found ${roleDefinitions.roles.length} defined roles`);

    return roleDefinitions;
  } catch (error) {
    (logger as any).error?.(`[Permissions] Failed to load ROLE_DEFINITIONS.yaml: ${error}`);
    throw new Error(`Failed to load role definitions: ${error}`);
  }
}

/**
 * Get role definition by ID
 */
export function getRoleDefinition(roleId: string): RoleDefinition | undefined {
  const definitions = loadRoleDefinitions();
  return definitions.roles.find((role) => role.id === roleId);
}

/**
 * Get all defined role IDs
 */
export function getAllRoleIds(): string[] {
  const definitions = loadRoleDefinitions();
  return definitions.roles.map((role) => role.id);
}

// =============================================================================
// Permission Validation Functions
// =============================================================================

/**
 * Check if a tool is allowed for a specific role
 *
 * @param roleId - The role ID (e.g., 'master', 'builder', 'product-owner')
 * @param toolName - The tool name to check (e.g., 'edit', 'bash', 'spawn_session')
 * @returns PermissionCheckResult with allow/deny decision and reason
 */
export async function checkToolPermission(
  roleId: string,
  toolName: string
): Promise<PermissionCheckResult> {
  // Normalize inputs
  const normalizedRoleId = roleId.toLowerCase().replace(/_/g, '-');
  const normalizedToolName = toolName.toLowerCase();

  // Check cache first
  const cacheKey = `${normalizedRoleId}:${normalizedToolName}`;
  const cachedResult = permissionCache.get(cacheKey);
  if (cachedResult !== undefined) {
    return {
      allowed: cachedResult,
      reason: cachedResult ? 'Cached: allowed' : 'Cached: denied',
      role: normalizedRoleId,
      tool: normalizedToolName,
    };
  }

  // Load role definitions
  const definitions = loadRoleDefinitions();
  const role = definitions.roles.find((r) => r.id === normalizedRoleId);

  if (!role) {
    // Unknown role - default to deny for safety
    logger.warn(`[Permissions] Unknown role: ${normalizedRoleId}. Denying access to ${normalizedToolName}`);
    return {
      allowed: false,
      reason: `Unknown role: ${normalizedRoleId}`,
      role: normalizedRoleId,
      tool: normalizedToolName,
    };
  }

  // Check 1: Explicit allowlist (role.tools)
  if (role.tools && role.tools.length > 0) {
    const toolPermission = role.tools.find((t: any) => t.name?.toLowerCase() === normalizedToolName);
    if (toolPermission) {
      const allowed = toolPermission.access === 'allow';
      await updateCache(cacheKey, allowed);
      return {
        allowed,
        reason: toolPermission.description || (allowed ? 'Explicitly allowed' : 'Explicitly denied'),
        role: normalizedRoleId,
        tool: normalizedToolName,
      };
    }
  }

  // Check 2: Explicit denylist (role.toolsToAvoid)
  if (role.toolsToAvoid) {
    const deniedTool = role.toolsToAvoid.find((t) => t.name.toLowerCase() === normalizedToolName);
    if (deniedTool) {
      await updateCache(cacheKey, false);
      return {
        allowed: false,
        reason: `Denied: ${deniedTool.reason}`,
        role: normalizedRoleId,
        tool: normalizedToolName,
      };
    }
  }

  // Check 3: Policy-level disallowed tools
  if (role.policy?.disallowedTools && role.policy.disallowedTools.length > 0) {
    const isDisallowed = role.policy.disallowedTools.some(
      (disallowed) => disallowed.toLowerCase() === normalizedToolName
    );
    if (isDisallowed) {
      await updateCache(cacheKey, false);
      return {
        allowed: false,
        reason: `Denied by role policy (disallowedTools)`,
        role: normalizedRoleId,
        tool: normalizedToolName,
      };
    }
  }

  // Check 4: Read-only access level
  if (role.policy?.accessLevel === 'read-only') {
    const readOnlyTools = ['edit', 'write_to_file', 'move_file', 'delete_file', 'replace_file_content'];
    const isReadOnlyTool = readOnlyTools.includes(normalizedToolName);

    if (isReadOnlyTool) {
      await updateCache(cacheKey, false);
      return {
        allowed: false,
        reason: `Denied: ${role.name} has read-only access level`,
        role: normalizedRoleId,
        tool: normalizedToolName,
      };
    }
  }

  // Default: Allow if not explicitly denied
  await updateCache(cacheKey, true);
  return {
    allowed: true,
    reason: 'Allowed by default (not explicitly denied)',
    role: normalizedRoleId,
    tool: normalizedToolName,
  };
}

/**
 * Check multiple tools at once (for batch operations)
 */
export async function checkToolPermissions(
  roleId: string,
  toolNames: string[]
): Promise<Map<string, PermissionCheckResult>> {
  const results = new Map<string, PermissionCheckResult>();

  for (const toolName of toolNames) {
    const result = await checkToolPermission(roleId, toolName);
    results.set(toolName, result);
  }

  return results;
}

/**
 * Get all allowed tools for a role
 */
export async function getAllowedTools(roleId: string): Promise<string[]> {
  const definitions = loadRoleDefinitions();
  const role = definitions.roles.find((r) => r.id === roleId.toLowerCase());

  if (!role) {
    logger.warn(`[Permissions] Unknown role: ${roleId}`);
    return [];
  }

  const allowedTools: string[] = [];

  // If role has explicit allowlist, return only those tools
  if (role.tools && role.tools.length > 0) {
    for (const tool of role.tools) {
      if ((tool as any).access === 'allow') {
        allowedTools.push((tool as any).name);
      }
    }
    return allowedTools;
  }

  // Otherwise, return all common tools except denied ones
  const commonTools = [
    'read',
    'grep',
    'find',
    'ast-grep',
    'edit',
    'write_to_file',
    'bash',
    'update_task',
    'list_tasks',
    'send_team_message',
    'spawn_session',
    'websearch_exa',
    'websearch',
    'webfetch',
  ];

  const deniedTools = new Set<string>();

  // Add toolsToAvoid to denied set
  if (role.toolsToAvoid) {
    role.toolsToAvoid.forEach((t) => deniedTools.add(t.name.toLowerCase()));
  }

  // Add policy disallowed tools
  if (role.policy?.disallowedTools) {
    role.policy.disallowedTools.forEach((t) => deniedTools.add(t.toLowerCase()));
  }

  // Add read-only restrictions
  if (role.policy?.accessLevel === 'read-only') {
    deniedTools.add('edit');
    deniedTools.add('write_to_file');
    deniedTools.add('move_file');
    deniedTools.add('delete_file');
    deniedTools.add('replace_file_content');
  }

  // Filter out denied tools
  for (const tool of commonTools) {
    if (!deniedTools.has(tool.toLowerCase())) {
      allowedTools.push(tool);
    }
  }

  return allowedTools;
}

/**
 * Get all denied tools for a role
 */
export async function getDeniedTools(roleId: string): Promise<string[]> {
  const definitions = loadRoleDefinitions();
  const role = definitions.roles.find((r) => r.id === roleId.toLowerCase());

  if (!role) {
    logger.warn(`[Permissions] Unknown role: ${roleId}`);
    return [];
  }

  const deniedTools: string[] = [];

  // Collect from toolsToAvoid
  if (role.toolsToAvoid) {
    role.toolsToAvoid.forEach((t) => deniedTools.push(t.name));
  }

  // Collect from policy disallowedTools
  if (role.policy?.disallowedTools) {
    role.policy.disallowedTools.forEach((t) => deniedTools.push(t));
  }

  // Add read-only restrictions
  if (role.policy?.accessLevel === 'read-only') {
    deniedTools.push('edit', 'write_to_file', 'move_file', 'delete_file', 'replace_file_content');
  }

  return deniedTools;
}

// =============================================================================
// Cache Management
// =============================================================================

/**
 * Update permission cache with mutex protection
 */
async function updateCache(key: string, value: boolean): Promise<void> {
  await cacheMutex.runExclusive(() => {
    permissionCache.set(key, value);
  });
}

/**
 * Clear permission cache (call when ROLE_DEFINITIONS.yaml changes)
 */
export async function clearPermissionCache(): Promise<void> {
  await cacheMutex.runExclusive(() => {
    permissionCache.clear();
    logger.debug('[Permissions] Permission cache cleared');
  });
}

/**
 * Get cache statistics
 */
export function getPermissionCacheStats(): { size: number; keys: string[] } {
  return {
    size: permissionCache.size,
    keys: Array.from(permissionCache.keys()),
  };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Validate role ID against defined roles
 */
export function isValidRole(roleId: string): boolean {
  const definitions = loadRoleDefinitions();
  return definitions.roles.some((role) => role.id === roleId.toLowerCase());
}

/**
 * Get role category by ID
 */
export function getRoleCategory(roleId: string): string | undefined {
  const role = getRoleDefinition(roleId);
  return role?.category;
}

/**
 * Get role display name by ID
 */
export function getRoleName(roleId: string): string | undefined {
  const role = getRoleDefinition(roleId);
  return role?.name;
}

/**
 * Get all roles in a category
 */
export function getRolesByCategory(category: string): RoleDefinition[] {
  const definitions = loadRoleDefinitions();
  return definitions.roles.filter((role) => role.category === category);
}

/**
 * Check if role is read-only
 */
export function isReadOnlyRole(roleId: string): boolean {
  const role = getRoleDefinition(roleId);
  return role?.policy?.accessLevel === 'read-only';
}

/**
 * Get role permission mode
 */
export function getPermissionMode(roleId: string): string {
  const role = getRoleDefinition(roleId);
  return role?.policy?.permissionMode || 'yolo';
}

// =============================================================================
// Export
// =============================================================================

export default {
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
};
