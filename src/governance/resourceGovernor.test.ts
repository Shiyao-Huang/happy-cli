import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  ResourceGovernor,
  getResourceGovernor,
  resetResourceGovernor,
  type HeavyOpKind,
} from './resourceGovernor';

const TEST_LOCKS_DIR = path.join(os.tmpdir(), `aha-rg-test-${Date.now()}`);

function makeMockHostHealth(freeMemBytes: number): () => ReturnType<typeof import('@/daemon/hostHealth').getHostHealth> {
  return () => ({
    freeMem: freeMemBytes,
    totalMem: 32_000_000_000,
    freeMemPct: Math.round((freeMemBytes / 32_000_000_000) * 100),
    diskFreeBytes: 100_000_000_000,
    diskTotalBytes: 500_000_000_000,
    diskFreePct: 20,
    diskMount: '/',
    activeAgentCount: 0,
    checkedAt: Date.now(),
    loadAvg1m: 1.0,
    loadAvg5m: 1.0,
    logFilesCount: 0,
    alerts: [],
  });
}

describe('ResourceGovernor', () => {
  beforeEach(() => {
    resetResourceGovernor();
    if (fs.existsSync(TEST_LOCKS_DIR)) {
      fs.rmSync(TEST_LOCKS_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_LOCKS_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_LOCKS_DIR)) {
      fs.rmSync(TEST_LOCKS_DIR, { recursive: true });
    }
  });

  it('grants slot when memory is sufficient and no lock exists', () => {
    const gov = new ResourceGovernor({
      locksDir: TEST_LOCKS_DIR,
      hostHealthProvider: makeMockHostHealth(20_000_000_000), // 20GB free
    });

    const result = gov.acquire('tsc');
    expect(result.granted).toBe(true);
    expect(result.lockFile).toBeDefined();
    expect(fs.existsSync(result.lockFile!)).toBe(true);
  });

  it('denies slot when memory is insufficient', () => {
    const gov = new ResourceGovernor({
      locksDir: TEST_LOCKS_DIR,
      hostHealthProvider: makeMockHostHealth(1_000_000_000), // 1GB free
    });

    const result = gov.acquire('tsc');
    expect(result.granted).toBe(false);
    expect(result.reason).toContain('Insufficient memory');
  });

  it('denies slot when another lock of same kind is active', () => {
    const gov = new ResourceGovernor({
      locksDir: TEST_LOCKS_DIR,
      hostHealthProvider: makeMockHostHealth(20_000_000_000),
    });

    const first = gov.acquire('tsc');
    expect(first.granted).toBe(true);

    const second = gov.acquire('tsc');
    expect(second.granted).toBe(false);
    expect(second.reason).toContain('already running');
    expect(second.existingLock).toBeDefined();
  });

  it('allows different kinds concurrently', () => {
    const gov = new ResourceGovernor({
      locksDir: TEST_LOCKS_DIR,
      hostHealthProvider: makeMockHostHealth(20_000_000_000),
    });

    const tsc = gov.acquire('tsc');
    expect(tsc.granted).toBe(true);

    const daemon = gov.acquire('daemon_restart');
    expect(daemon.granted).toBe(true);
  });

  it('releases slot and allows re-acquisition', () => {
    const gov = new ResourceGovernor({
      locksDir: TEST_LOCKS_DIR,
      hostHealthProvider: makeMockHostHealth(20_000_000_000),
    });

    const first = gov.acquire('tsc');
    expect(first.granted).toBe(true);

    gov.release('tsc');

    const second = gov.acquire('tsc');
    expect(second.granted).toBe(true);
  });

  it('checkBudget returns ok without acquiring', () => {
    const gov = new ResourceGovernor({
      locksDir: TEST_LOCKS_DIR,
      hostHealthProvider: makeMockHostHealth(20_000_000_000),
    });

    const budget = gov.checkBudget('tsc');
    expect(budget.ok).toBe(true);

    // Should not create lock
    const lockFile = path.join(TEST_LOCKS_DIR, 'tsc.lock');
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('listSlots reports correct lock status', () => {
    const gov = new ResourceGovernor({
      locksDir: TEST_LOCKS_DIR,
      hostHealthProvider: makeMockHostHealth(20_000_000_000),
    });

    const before = gov.listSlots();
    const tscBefore = before.find(s => s.kind === 'tsc');
    expect(tscBefore?.locked).toBe(false);

    gov.acquire('tsc');

    const after = gov.listSlots();
    const tscAfter = after.find(s => s.kind === 'tsc');
    expect(tscAfter?.locked).toBe(true);
  });

  it('singleton returns same instance', () => {
    const a = getResourceGovernor();
    const b = getResourceGovernor();
    expect(a).toBe(b);
  });

  it('reclaims expired locks', () => {
    const gov = new ResourceGovernor({
      locksDir: TEST_LOCKS_DIR,
      hostHealthProvider: makeMockHostHealth(20_000_000_000),
    });

    // Manually write an expired lock
    const lockFile = path.join(TEST_LOCKS_DIR, 'tsc.lock');
    const expired = new Date(Date.now() - 20 * 60_000).toISOString(); // 20 min ago
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: 99999,
      startedAt: expired,
      kind: 'tsc',
      path: '/tmp',
    }));

    const result = gov.acquire('tsc');
    expect(result.granted).toBe(true);
  });
});
