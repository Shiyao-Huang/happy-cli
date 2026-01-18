#!/usr/bin/env node
/**
 * Generate happy-server role configuration from ROLE_DEFINITIONS.yaml
 *
 * This command reads the unified ROLE_DEFINITIONS.yaml and generates
 * TypeScript configuration for the happy-server runtime.
 *
 * Usage:
 *   happy-cli generate-server-config [--source ROLE_DEFINITIONS.yaml]
 */

import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

interface RoleDefinition {
  category: string;
  priority: number;
  description: string;
  metadata: {
    model: string;
    temperature: number;
    thinkingBudget: number;
  };
  capabilities: string[];
  required_tools: string[];
  tools_to_avoid: string[];
  permissions: Record<string, string>;
  collaboration_protocol: string[];
  success_criteria: string[];
}

interface RoleDefinitions {
  roles: Record<string, RoleDefinition>;
  permission_matrix: {
    [tool: string]: {
      roles: string[];
      default_level: string;
    };
  };
}

function generateServerConfig(roleDefinitions: RoleDefinitions): string {
  const { roles, permission_matrix } = roleDefinitions;

  // Generate TypeScript configuration
  let content = `/**
 * Happy Server Role Configuration
 *
 * AUTO-GENERATED from ROLE_DEFINITIONS.yaml
 * DO NOT EDIT MANUALY - Regenerate with: happy-cli generate-server-config
 *
 * Generated: ${new Date().toISOString()}
 */

import { z } from 'zod';

/**
 * Permission levels enum
 */
export enum PermissionLevel {
  ALLOW = 'allow',
  ASK = 'ask',
  DENY = 'deny',
}

/**
 * Role metadata schema
 */
export const RoleMetadataSchema = z.object({
  model: z.string(),
  temperature: z.number().min(0).max(1),
  thinkingBudget: z.number().positive(),
});

/**
 * Single role configuration schema
 */
export const RoleConfigSchema = z.object({
  name: z.string(),
  category: z.string(),
  priority: z.number().int().positive(),
  description: z.string(),
  metadata: RoleMetadataSchema,
  capabilities: z.array(z.string()),
  requiredTools: z.array(z.string()),
  toolsToAvoid: z.array(z.string()),
  permissions: z.record(z.enum([PermissionLevel.ALLOW, PermissionLevel.ASK, PermissionLevel.DENY])),
  collaborationProtocol: z.array(z.string()),
  successCriteria: z.array(z.string()),
});

export type RoleConfig = z.infer<typeof RoleConfigSchema>;

/**
 * Complete role definitions
 */
export const ROLE_DEFINITIONS: Record<string, RoleConfig> = {
`;

  // Add each role
  for (const [roleName, role] of Object.entries(roles)) {
    content += `  '${roleName}': {\n`;
    content += `    name: '${roleName}',\n`;
    content += `    category: '${role.category}',\n`;
    content += `    priority: ${role.priority},\n`;
    content += `    description: '${role.description.replace(/'/g, "\\'")}',\n`;
    content += `    metadata: {\n`;
    content += `      model: '${role.metadata.model}',\n`;
    content += `      temperature: ${role.metadata.temperature},\n`;
    content += `      thinkingBudget: ${role.metadata.thinkingBudget},\n`;
    content += `    },\n`;
    content += `    capabilities: [\n`;
    role.capabilities.forEach(cap => {
      content += `      '${cap.replace(/'/g, "\\'")}',\n`;
    });
    content += `    ],\n`;
    content += `    requiredTools: [\n`;
    role.required_tools.forEach(tool => {
      content += `      '${tool}',\n`;
    });
    content += `    ],\n`;
    content += `    toolsToAvoid: [\n`;
    role.tools_to_avoid.forEach(tool => {
      content += `      '${tool}',\n`;
    });
    content += `    ],\n`;
    content += `    permissions: {\n`;
    Object.entries(role.permissions).forEach(([tool, level]) => {
      content += `      '${tool}': PermissionLevel.${level.toUpperCase()},\n`;
    });
    content += `    },\n`;
    content += `    collaborationProtocol: [\n`;
    role.collaboration_protocol.forEach(protocol => {
      content += `      '${protocol.replace(/'/g, "\\'")}',\n`;
    });
    content += `    ],\n`;
    content += `    successCriteria: [\n`;
    role.success_criteria.forEach(criterion => {
      content += `      '${criterion.replace(/'/g, "\\'")}',\n`;
    });
    content += `    ],\n`;
    content += `  },\n`;
  }

  content += `};\n\n`;

  // Add permission matrix
  content += `/**\n * Permission matrix: tool -> allowed roles\n */\nexport const PERMISSION_MATRIX: Record<string, {\n  allowedRoles: string[];\n  defaultLevel: PermissionLevel;\n}> = {\n`;

  for (const [tool, config] of Object.entries(permission_matrix)) {
    content += `  '${tool}': {\n`;
    content += `    allowedRoles: ${JSON.stringify(config.roles)},\n`;
    content += `    defaultLevel: PermissionLevel.${config.default_level.toUpperCase()},\n`;
    content += `  },\n`;
  }

  content += `};\n\n`;

  // Add helper functions
  content += `/**\n * Get role configuration by name\n */\nexport function getRoleConfig(roleName: string): RoleConfig | undefined {\n  return ROLE_DEFINITIONS[roleName];\n}\n\n`;

  content += `/**\n * Check if a role has permission for a tool\n */\nexport function hasPermission(roleName: string, tool: string): boolean {\n  const role = getRoleConfig(roleName);\n  if (!role) return false;\n  \n  const permission = role.permissions[tool];\n  return permission !== PermissionLevel.DENY;\n}\n\n`;

  content += `/**\n * Get permission level for a role and tool\n */\nexport function getPermissionLevel(roleName: string, tool: string): PermissionLevel {\n  const role = getRoleConfig(roleName);\n  if (!role) return PermissionLevel.DENY;\n  \n  return role.permissions[tool] ?? PermissionLevel.DENY;\n}\n\n`;

  content += `/**\n * Get all role names\n */\nexport function getAllRoles(): string[] {\n  return Object.keys(ROLE_DEFINITIONS);\n}\n\n`;

  content += `/**\n * Get roles by category\n */\nexport function getRolesByCategory(category: string): RoleConfig[] {\n  return Object.values(ROLE_DEFINITIONS).filter(role => role.category === category);\n}\n\n`;

  content += `export default ROLE_DEFINITIONS;\n`;

  return content;
}

function main() {
  const args = process.argv.slice(2);
  const sourceIndex = args.indexOf('--source');
  const sourcePath = sourceIndex >= 0 ? args[sourceIndex + 1] : '.happy/roles/ROLE_DEFINITIONS.yaml';

  // Resolve absolute path
  const absoluteSourcePath = path.resolve(process.cwd(), sourcePath);

  console.log(`📖 Reading role definitions from: ${absoluteSourcePath}`);

  // Read ROLE_DEFINITIONS.yaml
  if (!fs.existsSync(absoluteSourcePath)) {
    console.error(`❌ Error: ROLE_DEFINITIONS.yaml not found at ${absoluteSourcePath}`);
    process.exit(1);
  }

  const roleDefinitionsContent = fs.readFileSync(absoluteSourcePath, 'utf-8');
  const roleDefinitions: RoleDefinitions = yaml.parse(roleDefinitionsContent);

  console.log(`✅ Found ${Object.keys(roleDefinitions.roles).length} role definitions`);

  // Target directory for server config
  const targetDir = path.resolve(process.cwd(), 'happy-server/sources/config');

  // Create directory if it doesn't exist
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const targetFile = path.join(targetDir, 'roles.ts');

  // Generate content
  const content = generateServerConfig(roleDefinitions);

  // Check if file exists and compare
  let updated = false;
  if (fs.existsSync(targetFile)) {
    const existingContent = fs.readFileSync(targetFile, 'utf-8');
    if (existingContent !== content) {
      updated = true;
    }
  } else {
    updated = true;
  }

  // Write file
  fs.writeFileSync(targetFile, content, 'utf-8');

  console.log(`✅ Generated ${targetFile}`);
  console.log(`   Roles: ${Object.keys(roleDefinitions.roles).length}`);
  console.log(`   Status: ${updated ? 'Updated' : 'No changes'}`);
}

main();
