/**
 * @module hostHealth
 * @description Host machine health snapshot: memory, disk, CPU load, agent count, log accumulation.
 *
 * Used by:
 * - get_host_health MCP tool (all agents — part of self-awareness)
 * - get_self_view MCP tool (host health section)
 * - supervisorScheduler periodic alert (when thresholds exceeded)
 * - run.ts startup disk-low alert
 *
 * Design: pure, synchronous; no network calls; all exec calls capped at 5s.
 * Non-fatal by construction — each sub-check is isolated in try/catch.
 */

import os from 'os';
import { execSync } from 'child_process';

export interface HostHealthReport {
    /** Free physical RAM in bytes */
    freeMem: number;
    /** Total physical RAM in bytes */
    totalMem: number;
    /** freeMem / totalMem * 100, rounded */
    freeMemPct: number;
    /** Available disk bytes on the root / filesystem */
    diskFreeBytes: number;
    /** Total disk capacity bytes */
    diskTotalBytes: number;
    /** diskFreeBytes / diskTotalBytes * 100, rounded */
    diskFreePct: number;
    /** Mount point queried */
    diskMount: string;
    /** Number of tracked Claude/aha-cli agent sessions (caller-supplied) */
    activeAgentCount: number;
    /** Unix ms when this snapshot was taken */
    checkedAt: number;
    /** 1-minute load average */
    loadAvg1m: number;
    /** 5-minute load average */
    loadAvg5m: number;
    /** Number of *.log files in ahaHomeDir/logs/ (populated when ahaHomeDir supplied) */
    logFilesCount?: number;
    /**
     * Alert strings populated when resource thresholds are crossed.
     * Non-empty means operator/agent attention is needed.
     */
    alerts: string[];
}

/** Disk alert threshold (free% <= this → alert) */
export const DISK_ALERT_FREE_PCT = 10;

/** Memory alert threshold (free% <= this → alert) */
export const MEM_ALERT_FREE_PCT = 10;

/** Log file count threshold → alert */
export const LOG_FILES_ALERT_THRESHOLD = 200;

/** Agent count threshold → alert */
export const AGENT_COUNT_ALERT_THRESHOLD = 20;

/**
 * Return a point-in-time host health snapshot.
 *
 * @param activeAgentCount - pass pidToTrackedSession.size from the call site;
 *   defaults to 0 so callers without access to the session map can still use this.
 * @param ahaHomeDir - optional; when supplied, log file count in ahaHomeDir/logs/
 *   is included and log-accumulation alert is emitted when threshold exceeded.
 */
export function getHostHealth(activeAgentCount = 0, ahaHomeDir?: string): HostHealthReport {
    const freeMem = os.freemem();
    const totalMem = os.totalmem();
    const freeMemPct = totalMem > 0 ? Math.round((freeMem / totalMem) * 100) : 0;

    let diskFreeBytes = 0;
    let diskTotalBytes = 0;
    let diskFreePct = 0;
    let diskMount = '/';

    try {
        // `df -k /` outputs 1K-block counts — POSIX on macOS and Linux.
        // macOS: Filesystem  1024-blocks  Used  Available  Capacity  iused  ifree  %iused  Mounted on
        // Linux: Filesystem  1K-blocks    Used  Available  Use%      Mounted on
        // In both cases column 1 = total, column 3 = available, last column = mount.
        const dfOutput = execSync('df -k /', { encoding: 'utf-8', timeout: 5_000 });
        const lines = dfOutput.trim().split('\n');
        if (lines.length >= 2) {
            const parts = lines[1].split(/\s+/);
            const total1k = parseInt(parts[1], 10);
            const avail1k = parseInt(parts[3], 10);
            if (!isNaN(total1k) && !isNaN(avail1k) && total1k > 0) {
                diskFreeBytes = avail1k * 1024;
                diskTotalBytes = total1k * 1024;
                diskFreePct = Math.round((avail1k / total1k) * 100);
                diskMount = parts[parts.length - 1] || '/';
            }
        }
    } catch {
        // df unavailable or timed out — leave zeros; callers should handle gracefully.
    }

    // Load averages
    const [la1 = 0, la5 = 0] = os.loadavg();
    const loadAvg1m = Math.round(la1 * 100) / 100;
    const loadAvg5m = Math.round(la5 * 100) / 100;

    // Log file count (only when ahaHomeDir is supplied)
    let logFilesCount: number | undefined;
    if (ahaHomeDir) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { existsSync, readdirSync } = require('fs') as typeof import('fs');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const logsDir = (require('path') as typeof import('path')).join(ahaHomeDir, 'logs');
            logFilesCount = existsSync(logsDir)
                ? readdirSync(logsDir).filter((f: string) => f.endsWith('.log')).length
                : 0;
        } catch {
            // Non-fatal
        }
    }

    // Build alerts
    const alerts: string[] = [];
    if (diskFreePct <= DISK_ALERT_FREE_PCT && diskTotalBytes > 0) {
        const freeGB = (diskFreeBytes / 1_073_741_824).toFixed(1);
        alerts.push(`DISK_LOW: only ${diskFreePct}% free (${freeGB}GB) — consider cleaning ~/.aha/logs/`);
    }
    if (freeMemPct <= MEM_ALERT_FREE_PCT) {
        const freeMemMB = Math.round(freeMem / 1_048_576);
        alerts.push(`MEM_LOW: only ${freeMemPct}% free (${freeMemMB}MB)`);
    }
    if (activeAgentCount > AGENT_COUNT_ALERT_THRESHOLD) {
        alerts.push(`AGENT_COUNT_HIGH: ${activeAgentCount} agent sessions tracked`);
    }
    if (logFilesCount !== undefined && logFilesCount >= LOG_FILES_ALERT_THRESHOLD) {
        alerts.push(`LOGS_ACCUMULATING: ${logFilesCount} log files in ~/.aha/logs/ — old logs can be deleted`);
    }

    return {
        freeMem,
        totalMem,
        freeMemPct,
        diskFreeBytes,
        diskTotalBytes,
        diskFreePct,
        diskMount,
        activeAgentCount,
        checkedAt: Date.now(),
        loadAvg1m,
        loadAvg5m,
        logFilesCount,
        alerts,
    };
}

/** Format a HostHealthReport as a human-readable multi-line string. */
export function formatHostHealth(h: HostHealthReport): string {
    const freeMemMB = Math.round(h.freeMem / 1_048_576);
    const totalMemGB = Math.round(h.totalMem / 1_073_741_824);
    const diskFreeGB = (h.diskFreeBytes / 1_073_741_824).toFixed(1);
    const diskTotalGB = (h.diskTotalBytes / 1_073_741_824).toFixed(1);
    const ts = new Date(h.checkedAt).toISOString();
    const lines: string[] = [
        `Memory : ${freeMemMB} MB free / ${totalMemGB} GB total (${h.freeMemPct}% free)`,
        `Disk [${h.diskMount}]: ${diskFreeGB} GB free / ${diskTotalGB} GB total (${h.diskFreePct}% free)`,
        `Load avg : ${h.loadAvg1m} (1m) / ${h.loadAvg5m} (5m)`,
        `Active agent sessions : ${h.activeAgentCount}`,
    ];
    if (h.logFilesCount !== undefined) {
        lines.push(`Log files (~/.aha/logs/) : ${h.logFilesCount}`);
    }
    if (h.alerts.length > 0) {
        lines.push(`⚠️ Alerts : ${h.alerts.join(' | ')}`);
    }
    lines.push(`Snapshot at : ${ts}`);
    return lines.join('\n');
}
