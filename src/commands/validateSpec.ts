#!/usr/bin/env node
/**
 * OpenSpec Validation Tool
 *
 * Validates Spec documents against OpenSpec 1.0 specification
 * Ensures completeness, consistency, and correctness
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  missingSections: string[];
}

interface ValidationError {
  section: string;
  severity: 'critical' | 'error';
  message: string;
}

interface ValidationWarning {
  section: string;
  message: string;
}

/**
 * Validate a Spec document
 */
export function validateSpec(specPath: string): ValidationResult {
  const result: ValidationResult = {
    isValid: true,
    errors: [],
    warnings: [],
    missingSections: [],
  };

  // Check if file exists
  if (!existsSync(specPath)) {
    result.errors.push({
      section: 'file',
      severity: 'critical',
      message: `Spec file not found: ${specPath}`,
    });
    result.isValid = false;
    return result;
  }

  // Read file
  const content = readFileSync(specPath, 'utf-8');

  // Required sections (OpenSpec 1.0)
  const requiredSections = [
    { id: 'motivation', title: 'Motivation', required: true },
    { id: 'user-stories', title: 'User Stories', required: true },
    { id: 'functional-requirements', title: 'Functional Requirements', required: true },
    { id: 'acceptance-criteria', title: 'Acceptance Criteria', required: true },
    { id: 'technical-requirements', title: 'Technical Requirements', required: false },
    { id: 'architecture', title: 'Architecture', required: false },
  ];

  // Check for required sections
  requiredSections.forEach(section => {
    const hasSection =
      content.includes(`## ${section.title}`) ||
      content.includes(`### ${section.title}`);

    if (section.required && !hasSection) {
      result.missingSections.push(section.id);
      result.errors.push({
        section: section.id,
        severity: 'error',
        message: `Missing required section: "${section.title}"`,
      });
      result.isValid = false;
    }
  });

  // Validate metadata
  if (!content.includes('**Status:**')) {
    result.errors.push({
      section: 'metadata',
      severity: 'error',
      message: 'Missing status metadata (e.g., **Status:** Draft)',
    });
    result.isValid = false;
  }

  if (!content.includes('**Priority:**')) {
    result.warnings.push({
      section: 'metadata',
      message: 'Missing priority metadata (e.g., **Priority:** P0)',
    });
  }

  // Validate user stories format (GIVEN/WHEN/THEN)
  const userStorySection = content.substring(
    content.indexOf('## 2. User Stories'),
    content.indexOf('## 3.')
  );

  if (userStorySection.includes('### Story')) {
    const stories = userStorySection.split('### Story').slice(1);

    stories.forEach((story, index) => {
      const storyNum = index + 1;
      if (!story.includes('As a') || !story.includes('I want to') || !story.includes('So that')) {
        result.errors.push({
          section: 'user-stories',
          severity: 'error',
          message: `Story ${storyNum}: Missing user story format (As a... I want to... So that...)`,
        });
        result.isValid = false;
      }

      if (!story.includes('**GIVEN**') || !story.includes('**WHEN**') || !story.includes('**THEN**')) {
        result.warnings.push({
          section: 'user-stories',
          message: `Story ${storyNum}: Consider using GIVEN/WHEN/THEN format for scenarios`,
        });
      }
    });
  }

  // Validate requirements terminology (SHALL/MUST vs SHOULD)
  const functionalReqSection = content.substring(
    content.indexOf('## 3. Functional Requirements'),
    content.indexOf('## 4.')
  );

  if (functionalReqSection.includes('should') || functionalReqSection.includes('SHOULD')) {
    result.warnings.push({
      section: 'functional-requirements',
      message:
        'Use SHALL/MUST for requirements (not SHOULD). SHOULD is optional and not testable.',
    });
  }

  if (!functionalReqSection.includes('SHALL') && !functionalReqSection.includes('MUST')) {
    result.errors.push({
      section: 'functional-requirements',
      severity: 'error',
      message: 'Requirements must use SHALL or MUST terminology',
    });
    result.isValid = false;
  }

  // Validate acceptance criteria
  if (!content.includes('### Acceptance Criteria:') && !content.includes('**Acceptance Criteria:**')) {
    result.errors.push({
      section: 'acceptance-criteria',
      severity: 'error',
      message: 'Each user story must have acceptance criteria',
    });
    result.isValid = false;
  }

  // Check for testable criteria
  const acceptanceCriteria = content.match(/- \[ \] .*/g);
  if (acceptanceCriteria && acceptanceCriteria.length < 3) {
    result.warnings.push({
      section: 'acceptance-criteria',
      message: 'Acceptance criteria should have at least 3 testable items',
    });
  }

  // Validate technical requirements
  if (content.includes('## 4. Technical Requirements')) {
    const techReqSection = content.substring(
      content.indexOf('## 4. Technical Requirements'),
      content.indexOf('## 5.')
    );

    if (!techReqSection.includes('### Architecture Decisions')) {
      result.warnings.push({
        section: 'technical-requirements',
        message: 'Consider including Architecture Decision Records (ADRs)',
      });
    }

    if (!techReqSection.includes('### API Specifications') && !techReqSection.includes('### Data Model')) {
      result.warnings.push({
        section: 'technical-requirements',
        message: 'Technical requirements should include API specs or data models',
      });
    }
  }

  // Validate testing strategy
  if (!content.includes('## 7. Testing Strategy') && !content.includes('## 8. Testing Strategy')) {
    result.warnings.push({
      section: 'testing',
      message: 'Consider adding a Testing Strategy section',
    });
  }

  // Check for approval section
  if (!content.includes('**Approval:**') && !content.includes('## Approval')) {
    result.warnings.push({
      section: 'metadata',
      message: 'Spec should include approval section for sign-off',
    });
  }

  return result;
}

/**
 * Print validation results
 */
export function printValidationResults(result: ValidationResult, specPath: string): void {
  console.log(`\n📋 Validating: ${specPath}\n`);

  if (result.isValid) {
    console.log('✅ Spec is VALID!\n');
  } else {
    console.log('❌ Spec has ERRORS\n');
  }

  // Print missing sections
  if (result.missingSections.length > 0) {
    console.log('🚫 Missing Required Sections:');
    result.missingSections.forEach(section => {
      console.log(`   - ${section}`);
    });
    console.log('');
  }

  // Print errors
  if (result.errors.length > 0) {
    console.log('❌ Errors:');
    result.errors.forEach(error => {
      console.log(`   [${error.section}] ${error.message}`);
    });
    console.log('');
  }

  // Print warnings
  if (result.warnings.length > 0) {
    console.log('⚠️  Warnings:');
    result.warnings.forEach(warning => {
      console.log(`   [${warning.section}] ${warning.message}`);
    });
    console.log('');
  }

  // Summary
  console.log('Summary:');
  console.log(`   Errors: ${result.errors.length}`);
  console.log(`   Warnings: ${result.warnings.length}`);
  console.log(`   Status: ${result.isValid ? '✅ VALID' : '❌ INVALID'}\n`);
}

/**
 * CLI entry point
 */
export async function runValidateSpec(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === 'help') {
    console.log(`
OpenSpec Validation Tool

Usage: aha validate-spec <path-to-spec.md>

Validates Spec documents against OpenSpec 1.0 specification:
  ✓ Checks for required sections
  ✓ Validates user story format (As a... I want to... So that...)
  ✓ Ensures GIVEN/WHEN/THEN scenarios
  ✓ Validates requirement terminology (SHALL/MUST)
  ✓ Checks for acceptance criteria
  ✓ Reviews technical requirements
  ✓ Verifies testing strategy

Exit codes:
  0 - Spec is valid
  1 - Spec has errors
  2 - Usage error

Examples:
  aha validate-spec ./specs/user-authentication.md
  aha validate-spec ./changes/add-oauth/spec.md
`);
    return;
  }

  const specPath = resolve(args[0]);
  const result = validateSpec(specPath);
  printValidationResults(result, specPath);

  process.exit(result.isValid ? 0 : 1);
}
