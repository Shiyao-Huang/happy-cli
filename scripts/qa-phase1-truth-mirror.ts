import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isRetryableTaskSessionMismatchError,
  resolveTaskActorSessionId,
  runWithTaskSessionFallback,
  shouldRetryTaskSessionWithClient,
} from '../src/claude/mcp/taskTools';

type CaseResult = {
  id: string;
  category: 'resolve-session' | 'retryable-error' | 'retry-decision' | 'fallback-runner';
  description: string;
  input: unknown;
  expected: unknown;
  actual: unknown;
  pass: boolean;
};

const cases: CaseResult[] = [];

function addCase(item: Omit<CaseResult, 'pass'>) {
  const pass = JSON.stringify(item.expected) === JSON.stringify(item.actual);
  cases.push({ ...item, pass });
}

addCase({
  id: 'M-001',
  category: 'resolve-session',
  description: 'metadata.ahaSessionId present -> prefer authoritative session',
  input: { metadata: { ahaSessionId: 'server-1' }, clientSessionId: 'local-1' },
  expected: 'server-1',
  actual: resolveTaskActorSessionId({ ahaSessionId: 'server-1' }, 'local-1'),
});

addCase({
  id: 'M-002',
  category: 'resolve-session',
  description: 'metadata.ahaSessionId with surrounding spaces -> trimmed authoritative session',
  input: { metadata: { ahaSessionId: '  server-2  ' }, clientSessionId: 'local-2' },
  expected: 'server-2',
  actual: resolveTaskActorSessionId({ ahaSessionId: '  server-2  ' }, 'local-2'),
});

addCase({
  id: 'M-003',
  category: 'resolve-session',
  description: 'empty ahaSessionId -> fallback to client session',
  input: { metadata: { ahaSessionId: '' }, clientSessionId: 'local-3' },
  expected: 'local-3',
  actual: resolveTaskActorSessionId({ ahaSessionId: '' }, 'local-3'),
});

addCase({
  id: 'M-004',
  category: 'resolve-session',
  description: 'whitespace ahaSessionId -> fallback to client session',
  input: { metadata: { ahaSessionId: '   ' }, clientSessionId: 'local-4' },
  expected: 'local-4',
  actual: resolveTaskActorSessionId({ ahaSessionId: '   ' }, 'local-4'),
});

addCase({
  id: 'M-005',
  category: 'resolve-session',
  description: 'missing metadata -> fallback to client session',
  input: { metadata: undefined, clientSessionId: 'local-5' },
  expected: 'local-5',
  actual: resolveTaskActorSessionId(undefined, 'local-5'),
});

addCase({
  id: 'M-006',
  category: 'resolve-session',
  description: 'null metadata -> fallback to client session',
  input: { metadata: null, clientSessionId: 'local-6' },
  expected: 'local-6',
  actual: resolveTaskActorSessionId(null, 'local-6'),
});

addCase({
  id: 'M-007',
  category: 'resolve-session',
  description: 'metadata object without ahaSessionId -> fallback to client session',
  input: { metadata: {}, clientSessionId: 'local-7' },
  expected: 'local-7',
  actual: resolveTaskActorSessionId({}, 'local-7'),
});

addCase({
  id: 'M-008',
  category: 'resolve-session',
  description: 'non-string ahaSessionId -> fallback to client session',
  input: { metadata: { ahaSessionId: 123 as unknown as string }, clientSessionId: 'local-8' },
  expected: 'local-8',
  actual: resolveTaskActorSessionId({ ahaSessionId: 123 as unknown as string }, 'local-8'),
});

addCase({
  id: 'M-009',
  category: 'retryable-error',
  description: 'invalid actor session is retryable',
  input: { message: 'Invalid actor session for this team' },
  expected: true,
  actual: isRetryableTaskSessionMismatchError(new Error('Invalid actor session for this team')),
});

addCase({
  id: 'M-010',
  category: 'retryable-error',
  description: 'invalid reporterId for this team is retryable',
  input: { message: 'Invalid reporterId for this team' },
  expected: true,
  actual: isRetryableTaskSessionMismatchError(new Error('Invalid reporterId for this team')),
});

addCase({
  id: 'M-011',
  category: 'retryable-error',
  description: 'invalid reporter id variant is retryable',
  input: { message: 'invalid reporter id' },
  expected: true,
  actual: isRetryableTaskSessionMismatchError(new Error('invalid reporter id')),
});

addCase({
  id: 'M-012',
  category: 'retryable-error',
  description: 'status code 400 is retryable',
  input: { message: 'Request failed with status code 400' },
  expected: true,
  actual: isRetryableTaskSessionMismatchError(new Error('Request failed with status code 400')),
});

addCase({
  id: 'M-013',
  category: 'retryable-error',
  description: 'invalid session for this team is retryable',
  input: { message: 'Invalid session for this team' },
  expected: true,
  actual: isRetryableTaskSessionMismatchError(new Error('Invalid session for this team')),
});

addCase({
  id: 'M-014',
  category: 'retryable-error',
  description: 'network timeout is not retryable by session fallback guard',
  input: { message: 'Network timeout' },
  expected: false,
  actual: isRetryableTaskSessionMismatchError(new Error('Network timeout')),
});

addCase({
  id: 'M-015',
  category: 'retryable-error',
  description: 'generic 500 is not retryable by session fallback guard',
  input: { message: '500 Internal Server Error' },
  expected: false,
  actual: isRetryableTaskSessionMismatchError(new Error('500 Internal Server Error')),
});

addCase({
  id: 'M-016',
  category: 'retry-decision',
  description: 'retry allowed when attempted authoritative session mismatches and error is retryable',
  input: {
    metadata: { ahaSessionId: 'server' },
    clientSessionId: 'client',
    attemptedSessionId: 'server',
    error: 'Invalid actor session for this team',
  },
  expected: true,
  actual: shouldRetryTaskSessionWithClient({
    metadata: { ahaSessionId: 'server' },
    clientSessionId: 'client',
    attemptedSessionId: 'server',
    error: new Error('Invalid actor session for this team'),
  }),
});

addCase({
  id: 'M-017',
  category: 'retry-decision',
  description: 'no retry when authoritative and client session ids are identical',
  input: {
    metadata: { ahaSessionId: 'same' },
    clientSessionId: 'same',
    attemptedSessionId: 'same',
    error: 'Invalid actor session for this team',
  },
  expected: false,
  actual: shouldRetryTaskSessionWithClient({
    metadata: { ahaSessionId: 'same' },
    clientSessionId: 'same',
    attemptedSessionId: 'same',
    error: new Error('Invalid actor session for this team'),
  }),
});

addCase({
  id: 'M-018',
  category: 'retry-decision',
  description: 'no retry when attempted session already equals client session',
  input: {
    metadata: { ahaSessionId: 'server' },
    clientSessionId: 'client',
    attemptedSessionId: 'client',
    error: 'Invalid actor session for this team',
  },
  expected: false,
  actual: shouldRetryTaskSessionWithClient({
    metadata: { ahaSessionId: 'server' },
    clientSessionId: 'client',
    attemptedSessionId: 'client',
    error: new Error('Invalid actor session for this team'),
  }),
});

addCase({
  id: 'M-019',
  category: 'retry-decision',
  description: 'no retry when metadata has empty authoritative session',
  input: {
    metadata: { ahaSessionId: '' },
    clientSessionId: 'client',
    attemptedSessionId: 'client',
    error: 'Invalid actor session for this team',
  },
  expected: false,
  actual: shouldRetryTaskSessionWithClient({
    metadata: { ahaSessionId: '' },
    clientSessionId: 'client',
    attemptedSessionId: 'client',
    error: new Error('Invalid actor session for this team'),
  }),
});

addCase({
  id: 'M-020',
  category: 'retry-decision',
  description: 'no retry when error is not session-mismatch category',
  input: {
    metadata: { ahaSessionId: 'server' },
    clientSessionId: 'client',
    attemptedSessionId: 'server',
    error: 'Network timeout',
  },
  expected: false,
  actual: shouldRetryTaskSessionWithClient({
    metadata: { ahaSessionId: 'server' },
    clientSessionId: 'client',
    attemptedSessionId: 'server',
    error: new Error('Network timeout'),
  }),
});

addCase({
  id: 'M-021',
  category: 'retry-decision',
  description: 'no retry when metadata missing',
  input: {
    metadata: undefined,
    clientSessionId: 'client',
    attemptedSessionId: 'client',
    error: 'Invalid actor session for this team',
  },
  expected: false,
  actual: shouldRetryTaskSessionWithClient({
    metadata: undefined,
    clientSessionId: 'client',
    attemptedSessionId: 'client',
    error: new Error('Invalid actor session for this team'),
  }),
});

async function runAsyncCases() {
  const calls1: string[] = [];
  const ok1 = await runWithTaskSessionFallback({
    operation: 'create_task',
    metadata: { ahaSessionId: 'server-a' },
    clientSessionId: 'client-a',
    preferredSessionId: 'server-a',
    execute: async (sid: string) => {
      calls1.push(sid);
      return { ok: true, sid };
    },
  });

  addCase({
    id: 'M-022',
    category: 'fallback-runner',
    description: 'primary execution success -> no fallback retry',
    input: { metadataAhaSessionId: 'server-a', clientSessionId: 'client-a' },
    expected: { calls: ['server-a'], sessionId: 'server-a', result: { ok: true, sid: 'server-a' } },
    actual: { calls: calls1, sessionId: ok1.sessionId, result: ok1.result },
  });

  const calls2: string[] = [];
  const ok2 = await runWithTaskSessionFallback({
    operation: 'update_task',
    metadata: { ahaSessionId: 'server-b' },
    clientSessionId: 'client-b',
    preferredSessionId: 'server-b',
    execute: async (sid: string) => {
      calls2.push(sid);
      if (sid === 'server-b') {
        throw new Error('Invalid actor session for this team');
      }
      return { ok: true, sid };
    },
  });

  addCase({
    id: 'M-023',
    category: 'fallback-runner',
    description: 'session mismatch on preferred session -> retries with client session',
    input: { metadataAhaSessionId: 'server-b', clientSessionId: 'client-b' },
    expected: { calls: ['server-b', 'client-b'], sessionId: 'client-b', result: { ok: true, sid: 'client-b' } },
    actual: { calls: calls2, sessionId: ok2.sessionId, result: ok2.result },
  });

  const calls3: string[] = [];
  let err3: string | null = null;
  try {
    await runWithTaskSessionFallback({
      operation: 'add_task_comment',
      metadata: { ahaSessionId: 'server-c' },
      clientSessionId: 'client-c',
      preferredSessionId: 'server-c',
      execute: async (sid: string) => {
        calls3.push(sid);
        throw new Error('Network timeout');
      },
    });
  } catch (error) {
    err3 = error instanceof Error ? error.message : String(error);
  }

  addCase({
    id: 'M-024',
    category: 'fallback-runner',
    description: 'non-retryable error -> no fallback retry',
    input: { metadataAhaSessionId: 'server-c', clientSessionId: 'client-c', error: 'Network timeout' },
    expected: { calls: ['server-c'], error: 'Network timeout' },
    actual: { calls: calls3, error: err3 },
  });

  const calls4: string[] = [];
  let err4: string | null = null;
  try {
    await runWithTaskSessionFallback({
      operation: 'create_subtask',
      metadata: { ahaSessionId: 'same-d' },
      clientSessionId: 'same-d',
      preferredSessionId: 'same-d',
      execute: async (sid: string) => {
        calls4.push(sid);
        throw new Error('Invalid actor session for this team');
      },
    });
  } catch (error) {
    err4 = error instanceof Error ? error.message : String(error);
  }

  addCase({
    id: 'M-025',
    category: 'fallback-runner',
    description: 'no retry when metadata/client sessions are equal even on retryable error',
    input: { metadataAhaSessionId: 'same-d', clientSessionId: 'same-d', error: 'Invalid actor session for this team' },
    expected: { calls: ['same-d'], error: 'Invalid actor session for this team' },
    actual: { calls: calls4, error: err4 },
  });
}

async function main() {
  await runAsyncCases();

  const passedCases = cases.filter((c) => c.pass).length;
  const failedCases = cases.length - passedCases;

  const report = {
    generatedAt: new Date().toISOString(),
    scope: 'Gate-B/C truth mirror for task session authoritative id + fallback retry helpers',
    source: 'aha-cli-0330-max-redefine-login/src/claude/mcp/taskTools.ts',
    totalCases: cases.length,
    passedCases,
    failedCases,
    passRate: Number(((passedCases / cases.length) * 100).toFixed(2)),
    cases,
  };

  const outPath = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(process.cwd(), 'mozart/qa/phase1-golden-diff.json');

  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Wrote truth mirror report: ${outPath}`);
  console.log(`Cases: ${cases.length}, passed: ${passedCases}, failed: ${failedCases}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
