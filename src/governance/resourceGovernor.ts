/**
 * Resource Governor — unified heavy-operation slot management.
 *
 * Problem (#RA-001~#RA-006):
 *   - tsc_check had independent file lock (.aha/locks/tsc.lock)
 *   - restart_daemon had light-weight pre-check
 *   - build/expo/pkgroll/prisma had NO locks at all
 *   - No unified way to check resource availability
 *   - Agents could bypass MCP locks by running `yarn build` directly
 *
 * Solution:
 *   - Single ResourceGovernor class manages all heavy-operation slots.
 *   - Each slot type is exclusive (max 1 concurrent).
 *   - Memory check is global (any slot needs sufficient free RAM).
 *   - File locks with TTL to prevent dead locks.
 *   - MCP tools `acquire_heavy_op_slot` / `release_heavy_op_slot`.
 *   - `get_resource_status` exposes host health as MCP tool.
 */

import os from 'os';
import fs from 'fs';
import path from 'path';
import { getHostHealth, type HostHealthReport } from '@/daemon/hostHealth';

// ── Slot Definitions ─────────────────────────────────────────────────────────

/** Heavy operation kinds that require a slot */
export type HeavyOpKind =
  | 'tsc'
  | 'build'
  | 'pkgroll'
  | 'expo'
  | 'prisma'
  | 'daemon_restart'
  | 'vitest';

interface SlotConfig {
  /** Required free memory in MB */
  requiredMB: number;
  /** Safety factor applied to required memory */
  safetyFactor: number;
  /** Lock TTL in milliseconds */
  ttlMs: number;
  /** Human-readable description */
  description: string;
}

const SLOT_CONFIGS: Record<HeavyOpKind, SlotConfig> = {
  tsc:            { requiredMB: 8192, safetyFactor: 1.5, ttlMs: 10 * 60_000, description: 'TypeScript type check (~8GB)' },
  build:          { requiredMB: 12288, safetyFactor: 1.3, ttlMs: 15 * 60_000, description: 'Full build (~12GB)' },
  pkgroll:        { requiredMB: 4096, safetyFactor: 1.5, ttlMs: 10 * 60_000, description: 'Package bundling (~4GB)' },
  expo:           { requiredMB: 6144, safetyFactor: 1.5, ttlMs: 15 * 60_000, description: 'Expo build (~6GB)' },
  prisma:         { requiredMB: 2048, safetyFactor: 1.5, ttlMs: 10 * 60_000, description: 'Prisma migration (~2GB)' },
  daemon_restart: { requiredMB: 512, safetyFactor: 2.0, ttlMs: 5 * 60_000, description: 'Daemon restart (~0.5GB)' },
  vitest:         { requiredMB: 4096, safetyFactor: 1.5, ttlMs: 10 * 60_000, description: 'Full test run (~4GB)' },
};

// ── Lock Helpers ─────────────────────────────────────────────────────────────

interface LockInfo {
  pid: number;
  startedAt: string; // ISO 8601
  kind: HeavyOpKind;
  path: string;
}

function readLock(lockFile: string): LockInfo | null {
  try {
    const raw = fs.readFileSync(lockFile, 'utf-8').trim();
    const parsed = JSON.parse(raw) as LockInfo;
    if (parsed.pid && parsed.startedAt && parsed.kind) return parsed;
    return null;
  } catch {
    return null;
  }
}

function writeLock(lockFile: string, info: LockInfo): void {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify(info, null, 2), 'utf-8');
}

function removeLock(lockFile: string): void {
  try {
    fs.unlinkSync(lockFile);
  } catch { /* ignore */ }
}

function isLockExpired(info: LockInfo, ttlMs: number): boolean {
  const started = new Date(info.startedAt).getTime();
  return Date.now() - started > ttlMs;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── ResourceGovernor ─────────────────────────────────────────────────────────

export interface ResourceGovernorOptions {
  /** Where to store lock files; defaults to `.aha/locks` under cwd */
  locksDir?: string;
  /** Optional: inject a custom host-health provider for testing */
  hostHealthProvider?: () => HostHealthReport;
  /** ahaHomeDir for log file counting */
  ahaHomeDir?: string;
}

export interface AcquireResult {
  granted: boolean;
  /** Lock file path when granted */
  lockFile?: string;
  /** Human-readable reason when denied */
  reason?: string;
  /** Current free memory in MB */
  freeMemMB?: number;
  /** Required memory in MB */
  requiredMemMB?: number;
  /** Existing lock info when denied due to conflict */
  existingLock?: LockInfo;
}

export class ResourceGovernor {
  private readonly locksDir: string;
  private readonly hostHealthProvider: () => HostHealthReport;
  private readonly ahaHomeDir?: string;

  constructor(opts: ResourceGovernorOptions = {}) {
    this.locksDir = opts.locksDir ?? path.join(process.cwd(), '.aha', 'locks');
    this.hostHealthProvider = opts.hostHealthProvider ?? (() => getHostHealth(0, this.ahaHomeDir));
    this.ahaHomeDir = opts.ahaHomeDir;
  }

  /**
   * Acquire an exclusive slot for a heavy operation.
   *
   * Steps:
   * 1. Check global free memory against requiredMB * safetyFactor.
   * 2. Check if a lock file already exists (and is alive / not expired).
   * 3. Write lock file.
   */
  acquire(kind: HeavyOpKind, projectDir?: string): AcquireResult {
    const config = SLOT_CONFIGS[kind];
    const host = this.hostHealthProvider();
    const freeMemMB = Math.round(host.freeMem / 1_048_576);
    const requiredMemMB = Math.round(config.requiredMB * config.safetyFactor);

    // ── Memory budget check ──
    if (freeMemMB < requiredMemMB) {
      return {
        granted: false,
        reason: `Insufficient memory: ${freeMemMB}MB free, need ~${requiredMemMB}MB for ${config.description}. Wait for other processes to finish.`,
        freeMemMB,
        requiredMemMB,
      };
    }

    // ── Exclusive slot check ──
    const lockFile = path.join(this.locksDir, `${kind}.lock`);
    const existing = readLock(lockFile);

    if (existing) {
      // Expired locks are reclaimed automatically
      if (!isLockExpired(existing, config.ttlMs) && isProcessAlive(existing.pid)) {
        return {
          granted: false,
          reason: `Another ${kind} is already running (pid=${existing.pid}, started=${existing.startedAt}, path=${existing.path}). Wait for it to finish.`,
          freeMemMB,
          requiredMemMB,
          existingLock: existing,
        };
      }
      // Expired or dead process — reclaim the lock
      removeLock(lockFile);
    }

    // ── Write lock ──
    writeLock(lockFile, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      kind,
      path: projectDir ?? process.cwd(),
    });

    return {
      granted: true,
      lockFile,
      freeMemMB,
      requiredMemMB,
    };
  }

  /**
   * Release a previously acquired slot.
   * Safe to call even if the lock doesn't exist.
   */
  release(kind: HeavyOpKind): void {
    const lockFile = path.join(this.locksDir, `${kind}.lock`);
    removeLock(lockFile);
  }

  /**
   * Check resource budget without acquiring a slot.
   * Useful for agents that want to decide whether to proceed.
   */
  checkBudget(kind: HeavyOpKind): {
    ok: boolean;
    freeMemMB: number;
    requiredMemMB: number;
    reason?: string;
  } {
    const config = SLOT_CONFIGS[kind];
    const host = this.hostHealthProvider();
    const freeMemMB = Math.round(host.freeMem / 1_048_576);
    const requiredMemMB = Math.round(config.requiredMB * config.safetyFactor);

    if (freeMemMB < requiredMemMB) {
      return {
        ok: false,
        freeMemMB,
        requiredMemMB,
        reason: `Insufficient memory: ${freeMemMB}MB free, need ~${requiredMemMB}MB for ${config.description}.`,
      };
    }

    return { ok: true, freeMemMB, requiredMemMB };
  }

  /**
   * Get current slot status for all heavy-operation kinds.
   */
  listSlots(): Array<{
    kind: HeavyOpKind;
    locked: boolean;
    lockInfo?: LockInfo;
    config: SlotConfig;
  }> {
    const result: ReturnType<ResourceGovernor['listSlots']> = [];

    for (const kind of Object.keys(SLOT_CONFIGS) as HeavyOpKind[]) {
      const lockFile = path.join(this.locksDir, `${kind}.lock`);
      const info = readLock(lockFile);
      const expired = info ? isLockExpired(info, SLOT_CONFIGS[kind].ttlMs) : false;
      const alive = info ? isProcessAlive(info.pid) : false;

      result.push({
        kind,
        locked: info !== null && !expired && alive,
        lockInfo: info ?? undefined,
        config: SLOT_CONFIGS[kind],
      });
    }

    return result;
  }
}

// ── Singleton Instance ───────────────────────────────────────────────────────

let _governor: ResourceGovernor | null = null;

export function getResourceGovernor(opts?: ResourceGovernorOptions): ResourceGovernor {
  if (!_governor) {
    _governor = new ResourceGovernor(opts);
  }
  return _governor;
}

/** Reset singleton (useful for testing) */
export function resetResourceGovernor(): void {
  _governor = null;
}

// ── Convenience Exports ──────────────────────────────────────────────────────

export { SLOT_CONFIGS };
export type { SlotConfig, LockInfo };
