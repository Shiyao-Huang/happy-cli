import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runWithTaskSessionFallback } from '../src/claude/mcp/taskTools';

type FaultCaseResult = {
  id: string;
  scenario: string;
  injectedError: string;
  expectedBehavior: string;
  observed: {
    calls: string[];
    sessionId?: string;
    result?: unknown;
    error?: string;
  };
  pass: boolean;
};

async function runCase(caseId: string, scenario: string, config: {
  metadataAhaSessionId: string;
  clientSessionId: string;
  preferredSessionId: string;
  failMessage: string;
  failOnFirstOnly?: boolean;
  expectedCalls: string[];
  expectedSessionId?: string;
  expectedError?: string;
}) {
  const calls: string[] = [];
  let observedSessionId: string | undefined;
  let observedResult: unknown;
  let observedError: string | undefined;

  try {
    const out = await runWithTaskSessionFallback({
      operation: scenario,
      metadata: { ahaSessionId: config.metadataAhaSessionId },
      clientSessionId: config.clientSessionId,
      preferredSessionId: config.preferredSessionId,
      execute: async (sid) => {
        calls.push(sid);
        if (config.failOnFirstOnly && calls.length > 1) {
          return { ok: true, sid, recovered: true };
        }
        throw new Error(config.failMessage);
      },
    });
    observedSessionId = out.sessionId;
    observedResult = out.result;
  } catch (error) {
    observedError = error instanceof Error ? error.message : String(error);
  }

  const pass =
    JSON.stringify(calls) === JSON.stringify(config.expectedCalls)
    && (config.expectedSessionId ? observedSessionId === config.expectedSessionId : true)
    && (config.expectedError ? observedError === config.expectedError : true)
    && (!config.expectedError ? observedError === undefined : true);

  return {
    id: caseId,
    scenario,
    injectedError: config.failMessage,
    expectedBehavior: config.expectedError
      ? `No fallback retry; bubble original error (${config.expectedError})`
      : `Fallback retry succeeds with session ${config.expectedSessionId}`,
    observed: {
      calls,
      sessionId: observedSessionId,
      result: observedResult,
      error: observedError,
    },
    pass,
  } satisfies FaultCaseResult;
}

async function main() {
  const results: FaultCaseResult[] = [];

  results.push(await runCase('FI-001', 'update_task', {
    metadataAhaSessionId: 'stale-authoritative',
    clientSessionId: 'client-live',
    preferredSessionId: 'stale-authoritative',
    failMessage: 'Invalid actor session for this team',
    failOnFirstOnly: true,
    expectedCalls: ['stale-authoritative', 'client-live'],
    expectedSessionId: 'client-live',
  }));

  results.push(await runCase('FI-002', 'create_task', {
    metadataAhaSessionId: 'stale-authoritative-400',
    clientSessionId: 'client-live-400',
    preferredSessionId: 'stale-authoritative-400',
    failMessage: 'Request failed with status code 400',
    failOnFirstOnly: true,
    expectedCalls: ['stale-authoritative-400', 'client-live-400'],
    expectedSessionId: 'client-live-400',
  }));

  results.push(await runCase('FI-003', 'add_task_comment', {
    metadataAhaSessionId: 'stale-timeout',
    clientSessionId: 'client-timeout',
    preferredSessionId: 'stale-timeout',
    failMessage: 'Network timeout',
    expectedCalls: ['stale-timeout'],
    expectedError: 'Network timeout',
  }));

  results.push(await runCase('FI-004', 'create_subtask', {
    metadataAhaSessionId: 'stale-500',
    clientSessionId: 'client-500',
    preferredSessionId: 'stale-500',
    failMessage: '500 Internal Server Error',
    expectedCalls: ['stale-500'],
    expectedError: '500 Internal Server Error',
  }));

  results.push(await runCase('FI-005', 'start_task', {
    metadataAhaSessionId: 'stale-403',
    clientSessionId: 'client-403',
    preferredSessionId: 'stale-403',
    failMessage: '403 Forbidden',
    expectedCalls: ['stale-403'],
    expectedError: '403 Forbidden',
  }));

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;

  const payload = {
    generatedAt: new Date().toISOString(),
    scope: 'Fault injection for task session fallback guard',
    totalCases: results.length,
    passed,
    failed,
    passRate: Number(((passed / results.length) * 100).toFixed(2)),
    cases: results,
  };

  const outPath = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(process.cwd(), 'mozart/qa/phase1-fault-injection.json');

  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`Wrote fault injection report JSON: ${outPath}`);
  console.log(`Cases: ${results.length}, passed: ${passed}, failed: ${failed}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
