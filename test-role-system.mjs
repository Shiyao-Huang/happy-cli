#!/usr/bin/env node
/**
 * DEV119: Role System Verification & Testing
 *
 * This script tests the comprehensive role definition system including:
 * 1. ROLE_DEFINITIONS.yaml loading
 * 2. Category-based routing (oh-my-opencode pattern)
 * 3. Permission validation
 * 4. Backward compatibility
 * 5. Spec-Driven Development workflow
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ANSI color codes for output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logTest(testName) {
  console.log('\n' + '='.repeat(80));
  log(testName, 'cyan');
  console.log('='.repeat(80));
}

function logPass(message) {
  log(`✓ ${message}`, 'green');
}

function logFail(message) {
  log(`✗ ${message}`, 'red');
}

function logInfo(message) {
  log(`  ${message}`, 'blue');
}

// =============================================================================
// TEST 1: ROLE_DEFINITIONS.yaml Loading
// =============================================================================

async function testRoleDefinitionsLoading() {
  logTest('TEST 1: ROLE_DEFINITIONS.yaml Loading');

  const roleDefsPath = path.join(__dirname, '../happy-server/shared/role-definitions/ROLE_DEFINITIONS.yaml');

  try {
    // Check file exists
    if (!fs.existsSync(roleDefsPath)) {
      logFail(`ROLE_DEFINITIONS.yaml not found at: ${roleDefsPath}`);
      return false;
    }
    logPass(`ROLE_DEFINITIONS.yaml exists`);

    // Parse YAML
    const yamlContent = fs.readFileSync(roleDefsPath, 'utf8');
    const roleDefinitions = YAML.load(yamlContent);

    // Check metadata
    if (!roleDefinitions.metadata) {
      logFail('Missing metadata section');
      return false;
    }
    logPass(`Metadata found (version: ${roleDefinitions.metadata.version})`);

    // Check roles array
    if (!roleDefinitions.roles || !Array.isArray(roleDefinitions.roles)) {
      logFail('Missing or invalid roles array');
      return false;
    }
    logPass(`Roles array found (${roleDefinitions.roles.length} roles)`);

    // Check for expected roles
    const expectedRoles = ['master', 'product-owner', 'ux-designer', 'solution-architect', 'builder', 'framer', 'scout', 'scribe', 'qa', 'reviewer'];
    const foundRoles = roleDefinitions.roles.map(r => r.id);

    for (const expectedRole of expectedRoles) {
      if (foundRoles.includes(expectedRole)) {
        logPass(`Role found: ${expectedRole}`);
      } else {
        logFail(`Role missing: ${expectedRole}`);
      }
    }

    // Check for pending roles
    if (roleDefinitions.additionalRoles && roleDefinitions.additionalRoles.length > 0) {
      logInfo(`Pending roles: ${roleDefinitions.additionalRoles.length}`);
      roleDefinitions.additionalRoles.forEach(role => {
        logInfo(`  - ${role.id} (${role.status})`);
      });
    }

    // Check for advanced features
    const masterRole = roleDefinitions.roles.find(r => r.id === 'master');
    if (masterRole && masterRole.protocols && masterRole.protocols.workflows) {
      const hasCategoryRouting = masterRole.protocols.workflows.some(w => w.name === 'Category-Based Task Routing');
      const hasSpecDriven = masterRole.protocols.workflows.some(w => w.name === 'Spec-Driven Development Workflow');

      if (hasCategoryRouting) {
        logPass('Category-Based Task Routing workflow found');
      } else {
        logFail('Category-Based Task Routing workflow missing');
      }

      if (hasSpecDriven) {
        logPass('Spec-Driven Development Workflow found');
      } else {
        logFail('Spec-Driven Development Workflow missing');
      }
    }

    return true;
  } catch (error) {
    logFail(`Error loading ROLE_DEFINITIONS.yaml: ${error.message}`);
    return false;
  }
}

// =============================================================================
// TEST 2: Category-Based Routing (oh-my-opencode pattern)
// =============================================================================

async function testCategoryBasedRouting() {
  logTest('TEST 2: Category-Based Routing (oh-my-opencode pattern)');

  const categoriesPath = path.join(__dirname, '../kanban/sources/team-config/categories.json');

  try {
    // Check categories.json exists
    if (!fs.existsSync(categoriesPath)) {
      logFail(`categories.json not found at: ${categoriesPath}`);
      return false;
    }
    logPass('categories.json exists');

    // Parse JSON
    const categoriesContent = fs.readFileSync(categoriesPath, 'utf8');
    const categoriesConfig = JSON.parse(categoriesContent);

    // Check structure
    if (!categoriesConfig.categories) {
      logFail('Missing categories object');
      return false;
    }
    logPass(`Categories object found (${Object.keys(categoriesConfig.categories).length} categories)`);

    // Check for expected categories
    const expectedCategories = [
      'product-planning',
      'ux-design',
      'architecture',
      'code-implementation',
      'testing',
      'documentation'
    ];

    for (const expectedCat of expectedCategories) {
      if (categoriesConfig.categories[expectedCat]) {
        const cat = categoriesConfig.categories[expectedCat];
        logPass(`Category found: ${expectedCat} → ${cat.targetAgent}`);

        // Check category has required fields
        if (cat.targetAgent && cat.model && cat.temperature !== undefined && cat.promptAppend) {
          logPass(`  Complete configuration (model: ${cat.model}, temp: ${cat.temperature})`);
        } else {
          logFail(`  Incomplete configuration for ${expectedCat}`);
        }
      } else {
        logInfo(`Category not found (optional): ${expectedCat}`);
      }
    }

    // Check routing rules
    if (categoriesConfig.routingRules && Array.isArray(categoriesConfig.routingRules)) {
      logPass(`Routing rules found (${categoriesConfig.routingRules.length} rules)`);
      categoriesConfig.routingRules.forEach((rule, i) => {
        logInfo(`  Rule ${i + 1}: if ${rule.if.substring(0, 50)}... then ${rule.then}`);
      });
    }

    // Check default category
    if (categoriesConfig.defaultCategory) {
      logPass(`Default category: ${categoriesConfig.defaultCategory}`);
    }

    // Check concurrency limits
    if (categoriesConfig.concurrencyLimits) {
      logPass(`Concurrency limits configured (${Object.keys(categoriesConfig.concurrencyLimits).length} models)`);
    }

    return true;
  } catch (error) {
    logFail(`Error loading categories.json: ${error.message}`);
    return false;
  }
}

// =============================================================================
// TEST 3: Permission Validation
// =============================================================================

async function testPermissionValidation() {
  logTest('TEST 3: Permission Validation');

  const roleDefsPath = path.join(__dirname, '../happy-server/shared/role-definitions/ROLE_DEFINITIONS.yaml');

  try {
    const yamlContent = fs.readFileSync(roleDefsPath, 'utf8');
    const roleDefinitions = YAML.load(yamlContent);

    // Test permission modes
    const permissionModes = new Set();
    roleDefinitions.roles.forEach(role => {
      if (role.policy && role.policy.permissionMode) {
        permissionModes.add(role.policy.permissionMode);
      }
    });

    logPass(`Permission modes found: ${Array.from(permissionModes).join(', ')}`);

    // Test access levels
    const accessLevels = new Set();
    roleDefinitions.roles.forEach(role => {
      if (role.policy && role.policy.accessLevel) {
        accessLevels.add(role.policy.accessLevel);
      }
    });

    logPass(`Access levels found: ${Array.from(accessLevels).join(', ')}`);

    // Test specific role permissions
    const testCases = [
      {
        role: 'scout',
        expectedAccessLevel: 'read-only',
        expectedPermissionMode: 'read-only'
      },
      {
        role: 'reviewer',
        expectedAccessLevel: 'read-only',
        expectedPermissionMode: 'read-only'
      },
      {
        role: 'master',
        expectedAccessLevel: 'read-only',
        expectedPermissionMode: 'plan'
      },
      {
        role: 'builder',
        expectedAccessLevel: undefined, // Should not have accessLevel restriction
        expectedPermissionMode: 'yolo'
      }
    ];

    for (const testCase of testCases) {
      const role = roleDefinitions.roles.find(r => r.id === testCase.role);
      if (role) {
        const actualAccessLevel = role.policy?.accessLevel;
        const actualPermissionMode = role.policy?.permissionMode;

        if (actualAccessLevel === testCase.expectedAccessLevel) {
          logPass(`${testCase.role}: accessLevel = ${actualAccessLevel || 'full-access'}`);
        } else {
          logFail(`${testCase.role}: accessLevel = ${actualAccessLevel || 'full-access'} (expected ${testCase.expectedAccessLevel || 'full-access'})`);
        }

        if (actualPermissionMode === testCase.expectedPermissionMode) {
          logPass(`${testCase.role}: permissionMode = ${actualPermissionMode}`);
        } else {
          logFail(`${testCase.role}: permissionMode = ${actualPermissionMode} (expected ${testCase.expectedPermissionMode})`);
        }
      } else {
        logFail(`Role not found: ${testCase.role}`);
      }
    }

    return true;
  } catch (error) {
    logFail(`Error testing permissions: ${error.message}`);
    return false;
  }
}

// =============================================================================
// TEST 4: Backward Compatibility
// =============================================================================

async function testBackwardCompatibility() {
  logTest('TEST 4: Backward Compatibility');

  const rolesConfigPath = path.join(__dirname, 'src/claude/team/roles.config.ts');

  try {
    // Check roles.config.ts exists
    if (!fs.existsSync(rolesConfigPath)) {
      logFail(`roles.config.ts not found at: ${rolesConfigPath}`);
      return false;
    }
    logPass('roles.config.ts exists');

    // Read and parse ROLE_ID_MIGRATIONS
    const rolesConfigContent = fs.readFileSync(rolesConfigPath, 'utf8');

    // Check for migration mappings
    if (rolesConfigContent.includes('ROLE_ID_MIGRATIONS')) {
      logPass('ROLE_ID_MIGRATIONS found');
    } else {
      logFail('ROLE_ID_MIGRATIONS not found');
      return false;
    }

    // Check for Proxy-based backward compatibility
    if (rolesConfigContent.includes('new Proxy')) {
      logPass('Proxy-based backward compatibility implementation found');
    } else {
      logFail('Proxy-based backward compatibility not found');
    }

    // Check for expected migrations
    const expectedMigrations = [
      { old: 'master', new: 'master-coordinator' },
      { old: 'framer', new: 'framing-engineer' },
      { old: 'builder', new: 'builder-/-executor' },
      { old: 'reviewer', new: 'reviewer-/-observer' }
    ];

    for (const migration of expectedMigrations) {
      if (rolesConfigContent.includes(`'${migration.old}': '${migration.new}'`)) {
        logPass(`Migration mapping found: ${migration.old} → ${migration.new}`);
      } else {
        logFail(`Migration mapping missing: ${migration.old} → ${migration.new}`);
      }
    }

    return true;
  } catch (error) {
    logFail(`Error testing backward compatibility: ${error.message}`);
    return false;
  }
}

// =============================================================================
// TEST 5: Integration Files
// =============================================================================

async function testIntegrationFiles() {
  logTest('TEST 5: Integration Files');

  const integrationFiles = [
    {
      path: 'src/claude/team/roles.ts',
      description: 'Role permission enforcement'
    },
    {
      path: 'src/claude/team/roles.config.ts',
      description: 'Role configuration & backward compatibility'
    },
    {
      path: 'src/claude/team/permissions.ts',
      description: 'Runtime permission validation'
    },
    {
      path: '../shared/team-config/ROLE_REGISTRY.cjs',
      description: 'Dynamic role loader from SKILL.md files'
    }
  ];

  let allExists = true;

  for (const file of integrationFiles) {
    const filePath = path.join(__dirname, file.path);
    if (fs.existsSync(filePath)) {
      logPass(`${file.description}: ${file.path}`);
    } else {
      logFail(`File not found: ${file.path}`);
      allExists = false;
    }
  }

  return allExists;
}

// =============================================================================
// TEST 6: Build Verification
// =============================================================================

async function testBuildVerification() {
  logTest('TEST 6: Build Verification');

  const { execSync } = await import('child_process');

  try {
    logInfo('Running TypeScript compilation check...');
    execSync('npx tsc --noEmit', { cwd: __dirname, stdio: 'pipe' });
    logPass('TypeScript compilation successful');
    return true;
  } catch (error) {
    logFail(`TypeScript compilation failed: ${error.message}`);
    return false;
  }
}

// =============================================================================
// Main Test Runner
// =============================================================================

async function runAllTests() {
  console.log('\n╔════════════════════════════════════════════════════════════════════╗');
  console.log('║   DEV119: Role System Verification & Testing                    ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝\n');

  const results = [];

  results.push({ name: 'ROLE_DEFINITIONS.yaml Loading', pass: await testRoleDefinitionsLoading() });
  results.push({ name: 'Category-Based Routing', pass: await testCategoryBasedRouting() });
  results.push({ name: 'Permission Validation', pass: await testPermissionValidation() });
  results.push({ name: 'Backward Compatibility', pass: await testBackwardCompatibility() });
  results.push({ name: 'Integration Files', pass: await testIntegrationFiles() });
  results.push({ name: 'Build Verification', pass: await testBuildVerification() });

  // Print summary
  console.log('\n' + '='.repeat(80));
  log('TEST SUMMARY', 'cyan');
  console.log('='.repeat(80));

  const passed = results.filter(r => r.pass).length;
  const total = results.length;

  results.forEach(result => {
    if (result.pass) {
      logPass(result.name);
    } else {
      logFail(result.name);
    }
  });

  console.log('\n' + '='.repeat(80));
  if (passed === total) {
    log(`✓ ALL TESTS PASSED (${passed}/${total})`, 'green');
    console.log('='.repeat(80) + '\n');
    return 0;
  } else {
    log(`✗ SOME TESTS FAILED (${passed}/${total} passed)`, 'red');
    console.log('='.repeat(80) + '\n');
    return 1;
  }
}

// Run tests
runAllTests().then(exitCode => {
  process.exit(exitCode);
}).catch(error => {
  logFatal(`Fatal error: ${error.message}`);
  process.exit(1);
});

function logFatal(message) {
  log(message, 'red');
}
