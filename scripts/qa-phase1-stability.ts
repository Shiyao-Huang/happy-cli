import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runWithTaskSessionFallback } from '../src/claude/mcp/taskTools';

type TestResult = {
  id: string;
  scenario: string;
  total: number;
  success: number;
  failure: number;
  successRate: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
};

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return Number(sorted[idx].toFixed(3));
}

async function sequential200(): Promise<TestResult> {
  const total = 200;
  let success = 0;
  let failure = 0;
  const latencies: number[] = [];

  for (let i = 0; i < total; i += 1) {
    const started = performance.now();
    try {
      let first = true;
      await runWithTaskSessionFallback({
        operation: 'stability-seq',
        metadata: { ahaSessionId: `server-${i}` },
        clientSessionId: `client-${i}`,
        preferredSessionId: `server-${i}`,
        execute: async (sid) => {
          if (first && i % 2 === 0) {
            first = false;
            throw new Error('Invalid actor session for this team');
          }
          return { ok: true, sid };
        },
      });
      success += 1;
    } catch {
      failure += 1;
    } finally {
      latencies.push(performance.now() - started);
    }
  }

  return {
    id: 'S-001',
    scenario: '200 sequential calls (50% require fallback retry)',
    total,
    success,
    failure,
    successRate: Number(((success / total) * 100).toFixed(2)),
    p50Ms: quantile(latencies, 0.5),
    p95Ms: quantile(latencies, 0.95),
    maxMs: quantile(latencies, 1),
  };
}

async function concurrent20(): Promise<TestResult> {
  const total = 20;
  const latencies: number[] = [];

  const tasks = Array.from({ length: total }, (_, i) => (async () => {
    const started = performance.now();
    let first = true;
    try {
      await runWithTaskSessionFallback({
        operation: 'stability-concurrent',
        metadata: { ahaSessionId: `server-c-${i}` },
        clientSessionId: `client-c-${i}`,
        preferredSessionId: `server-c-${i}`,
        execute: async (sid) => {
          if (first && i % 3 === 0) {
            first = false;
            throw new Error('Request failed with status code 400');
          }
          return { ok: true, sid };
        },
      });
      return { ok: true };
    } catch {
      return { ok: false };
    } finally {
      latencies.push(performance.now() - started);
    }
  })());

  const settled = await Promise.all(tasks);
  const success = settled.filter((x) => x.ok).length;
  const failure = total - success;

  return {
    id: 'S-002',
    scenario: '20 concurrent calls (33% require fallback retry)',
    total,
    success,
    failure,
    successRate: Number(((success / total) * 100).toFixed(2)),
    p50Ms: quantile(latencies, 0.5),
    p95Ms: quantile(latencies, 0.95),
    maxMs: quantile(latencies, 1),
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const [seq, con] = await Promise.all([sequential200(), concurrent20()]);
  const endedAt = new Date().toISOString();

  const payload = {
    startedAt,
    endedAt,
    scope: 'Stability probes for task session fallback helper',
    results: [seq, con],
    overall: {
      total: seq.total + con.total,
      success: seq.success + con.success,
      failure: seq.failure + con.failure,
      successRate: Number((((seq.success + con.success) / (seq.total + con.total)) * 100).toFixed(2)),
    },
  };

  const outPath = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(process.cwd(), 'mozart/qa/phase1-stability-report.json');

  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`Wrote stability report JSON: ${outPath}`);
  console.log(`Overall success rate: ${payload.overall.successRate}% (${payload.overall.success}/${payload.overall.total})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
