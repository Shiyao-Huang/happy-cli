/**
 * Quality Gate Module
 *
 * Configurable, extensible quality gates with structured results.
 * Each iteration of the Ralph Loop must pass all enabled checks
 * before changes are committed.
 *
 * Three layers:
 *   Layer 1: Type check → catches type errors
 *   Layer 2: Test run   → verifies behavior correctness
 *   Layer 3: Build      → ensures build stays green
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/ui/logger';

// === Types ===

export interface QualityChecks {
    typeCheck: boolean;
    testRun: boolean;
    buildVerify: boolean;
}

export interface CheckResult {
    name: string;
    passed: boolean;
    output: string;
    durationMs: number;
}

export interface QualityResult {
    passed: boolean;
    failures: CheckResult[];
    results: CheckResult[];
    summary: string;
    totalDurationMs: number;
}

// === Default Check Configuration ===

const DEFAULT_CHECKS: QualityChecks = {
    typeCheck: true,
    testRun: true,
    buildVerify: true,
};

// === Quality Gate Implementation ===

/**
 * Run all enabled quality checks against a working directory.
 *
 * Checks run sequentially so early failures can short-circuit.
 * Returns a structured result with per-check details.
 */
export async function runQualityGate(
    workingDirectory: string,
    checks: Partial<QualityChecks> = {},
): Promise<QualityResult> {
    const effectiveChecks = { ...DEFAULT_CHECKS, ...checks };
    const results: CheckResult[] = [];
    const startTime = Date.now();

    logger.debug(`[QualityGate] Starting quality checks in ${workingDirectory}`);
    logger.debug(`[QualityGate] Enabled: typeCheck=${effectiveChecks.typeCheck}, testRun=${effectiveChecks.testRun}, buildVerify=${effectiveChecks.buildVerify}`);

    // Detect package manager
    const pm = detectPackageManager(workingDirectory);

    if (effectiveChecks.typeCheck) {
        const result = await runTypeCheck(workingDirectory, pm);
        results.push(result);
        if (!result.passed) {
            logger.debug(`[QualityGate] Type check FAILED, skipping remaining checks`);
            return buildResult(results, startTime);
        }
    }

    if (effectiveChecks.testRun) {
        const result = await runTests(workingDirectory, pm);
        results.push(result);
        if (!result.passed) {
            logger.debug(`[QualityGate] Tests FAILED, skipping remaining checks`);
            return buildResult(results, startTime);
        }
    }

    if (effectiveChecks.buildVerify) {
        const result = await runBuild(workingDirectory, pm);
        results.push(result);
    }

    return buildResult(results, startTime);
}

// === Individual Check Runners ===

async function runTypeCheck(workingDirectory: string, pm: string): Promise<CheckResult> {
    logger.debug('[QualityGate] Running type check...');

    // Try tsc first, then fall back to package script
    const hasTsConfig = existsSync(join(workingDirectory, 'tsconfig.json'));

    if (hasTsConfig) {
        return runCommand('Type Check', 'npx', ['tsc', '--noEmit'], workingDirectory);
    }

    // Fall back to npm/yarn/pnpm script
    return runCommand('Type Check', pm, ['run', 'typecheck'], workingDirectory);
}

async function runTests(workingDirectory: string, pm: string): Promise<CheckResult> {
    logger.debug('[QualityGate] Running tests...');
    return runCommand('Tests', pm, ['test', '--', '--run'], workingDirectory);
}

async function runBuild(workingDirectory: string, pm: string): Promise<CheckResult> {
    logger.debug('[QualityGate] Running build...');
    return runCommand('Build', pm, ['run', 'build'], workingDirectory);
}

// === Helpers ===

function detectPackageManager(workingDirectory: string): string {
    if (existsSync(join(workingDirectory, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(join(workingDirectory, 'yarn.lock'))) return 'yarn';
    if (existsSync(join(workingDirectory, 'bun.lockb'))) return 'bun';
    return 'npm';
}

function runCommand(
    name: string,
    command: string,
    args: string[],
    cwd: string,
): Promise<CheckResult> {
    const startTime = Date.now();

    return new Promise((resolve) => {
        const child = execFile(command, args, {
            cwd,
            timeout: 120_000, // 2 minute timeout per check
            maxBuffer: 5 * 1024 * 1024, // 5MB output buffer
            env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
        }, (error, stdout, stderr) => {
            const durationMs = Date.now() - startTime;
            const output = [stdout, stderr].filter(Boolean).join('\n').trim();
            const passed = !error;

            logger.debug(`[QualityGate] ${name}: ${passed ? 'PASSED' : 'FAILED'} in ${durationMs}ms`);

            resolve({
                name,
                passed,
                output: truncateOutput(output, 2000),
                durationMs,
            });
        });

        // Handle spawn errors
        child.on('error', (err) => {
            const durationMs = Date.now() - startTime;
            resolve({
                name,
                passed: false,
                output: `Failed to run: ${err.message}`,
                durationMs,
            });
        });
    });
}

function truncateOutput(output: string, maxLength: number): string {
    if (output.length <= maxLength) return output;
    const half = Math.floor(maxLength / 2) - 10;
    return `${output.substring(0, half)}\n\n... [truncated ${output.length - maxLength} chars] ...\n\n${output.substring(output.length - half)}`;
}

function buildResult(results: CheckResult[], startTime: number): QualityResult {
    const totalDurationMs = Date.now() - startTime;
    const failures = results.filter(r => !r.passed);
    const passed = failures.length === 0;

    const summary = results.map(r =>
        `${r.passed ? 'PASS' : 'FAIL'} ${r.name} (${r.durationMs}ms)`
    ).join('\n');

    return {
        passed,
        failures,
        results,
        summary,
        totalDurationMs,
    };
}

/**
 * Format a quality result for human-readable display.
 */
export function formatQualityResult(result: QualityResult): string {
    const header = result.passed
        ? 'Quality Gate: PASSED'
        : `Quality Gate: FAILED (${result.failures.length} failure(s))`;

    const lines = [
        header,
        '─'.repeat(40),
        result.summary,
        '─'.repeat(40),
        `Total: ${result.totalDurationMs}ms`,
    ];

    if (!result.passed) {
        lines.push('');
        lines.push('Failure details:');
        for (const failure of result.failures) {
            lines.push(`\n--- ${failure.name} ---`);
            lines.push(failure.output);
        }
    }

    return lines.join('\n');
}
