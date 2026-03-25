#!/usr/bin/env node
/**
 * Generate SKILL.md files from ROLE_DEFINITIONS.yaml
 *
 * This command reads the unified ROLE_DEFINITIONS.yaml and generates
 * SKILL.md files for each role in the kanban project.
 *
 * Usage:
 *   happy-cli generate-skills [--source ROLE_DEFINITIONS.yaml]
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
  workflows?: Array<{
    name: string;
    steps: string[];
  }>;
  success_criteria: string[];
}

interface RoleDefinitions {
  roles: Record<string, RoleDefinition>;
}

function generateSKILLMD(roleName: string, role: RoleDefinition): string {
  const frontmatter = {
    name: roleName,
    description: role.description,
    license: 'MIT',
    compatibility: 'ohmyopencode',
    metadata: {
      model: role.metadata.model,
      temperature: role.metadata.temperature,
      thinkingBudget: role.metadata.thinkingBudget,
    },
  };

  let content = `---
${yaml.stringify(frontmatter).trim()}
---

### Capabilities
${role.capabilities.map(c => `- ${c}`).join('\n')}

### Required Tools
${role.required_tools.map(t => {
  const [tool, desc] = t.includes('(') ? t.split('(') : [t, ''];
  const cleanDesc = desc ? desc.replace(')', '').trim() : '';
  return cleanDesc ? `- ${tool.trim()} (${cleanDesc})` : `- ${tool}`;
}).join('\n')}
### Tools To Avoid
${role.tools_to_avoid.map(t => `- ${t}`).join('\n')}
`;

  // Add permissions section if available
  if (role.permissions && Object.keys(role.permissions).length > 0) {
    content += `### Permission\n`;
    Object.entries(role.permissions).forEach(([tool, level]) => {
      content += `${tool}: "${level}"\n`;
    });
    content += '\n';
  }

  // Add collaboration protocol if available
  if (role.collaboration_protocol && role.collaboration_protocol.length > 0) {
    content += `### Collaboration Protocol\n`;
    role.collaboration_protocol.forEach((protocol, i) => {
      content += `${i + 1}. ${protocol}\n`;
    });
    content += '\n';
  }

  // Add workflows if available
  if (role.workflows && role.workflows.length > 0) {
    content += `### Common Workflows\n`;
    role.workflows.forEach(workflow => {
      content += `1. **${workflow.name}**:\n`;
      workflow.steps.forEach(step => {
        content += `   - ${step}\n`;
      });
    });
    content += '\n';
  }

  // Add success criteria if available
  if (role.success_criteria && role.success_criteria.length > 0) {
    content += `### Success Criteria\n`;
    role.success_criteria.forEach(criterion => {
      content += `- ${criterion}\n`;
    });
  }

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

  // Target directory for SKILL.md files
  // Try to find the kanban directory relative to the current working directory
  const possiblePaths = [
    path.resolve(process.cwd(), 'kanban/sources/team-config/skills'),
    path.resolve(process.cwd(), '../kanban/sources/team-config/skills'),
    path.resolve('/Users/swmt/happy/kanban/sources/team-config/skills'),
  ];

  let targetDir: string | undefined;
  for (const testPath of possiblePaths) {
    if (fs.existsSync(testPath)) {
      targetDir = testPath;
      break;
    }
  }

  if (!targetDir) {
    console.error(`❌ Error: Could not find kanban/sources/team-config/skills directory`);
    console.error('   Tried paths:');
    possiblePaths.forEach(p => console.error(`   - ${p}`));
    process.exit(1);
  }

  // Generate SKILL.md for each role
  let generated = 0;
  let updated = 0;
  let skipped = 0;

  for (const [roleName, role] of Object.entries(roleDefinitions.roles)) {
    const roleDir = path.join(targetDir, roleName);
    const skillFile = path.join(roleDir, 'SKILL.md');

    // Generate content
    const content = generateSKILLMD(roleName, role);

    // Check if file exists
    if (fs.existsSync(skillFile)) {
      // Read existing file and compare
      const existingContent = fs.readFileSync(skillFile, 'utf-8');
      if (existingContent === content) {
        console.log(`⏭️  Skipped ${roleName} (no changes)`);
        skipped++;
        continue;
      }
    }

    // Create directory if it doesn't exist
    if (!fs.existsSync(roleDir)) {
      fs.mkdirSync(roleDir, { recursive: true });
    }

    // Write SKILL.md
    fs.writeFileSync(skillFile, content, 'utf-8');
    console.log(`✅ Generated ${roleName}/SKILL.md`);
    generated++;
  }

  console.log('\n📊 Summary:');
  console.log(`   Generated: ${generated}`);
  console.log(`   Updated: ${updated}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   Total: ${Object.keys(roleDefinitions.roles).length}`);
}

main();
