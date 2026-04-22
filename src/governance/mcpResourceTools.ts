/**
 * MCP tools for resource governance.
 *
 * Registers:
 * - get_resource_status  — host health + slot status
 * - acquire_heavy_op_slot — request exclusive slot
 * - release_heavy_op_slot — release exclusive slot
 *
 * All agents can call get_resource_status.
 * Only roles with @granted opt-in or explicit permission can acquire/release slots.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getResourceGovernor,
  type HeavyOpKind,
  SLOT_CONFIGS,
} from './resourceGovernor';
import { getHostHealth } from '@/daemon/hostHealth';

const HEAVY_OP_KINDS = Object.keys(SLOT_CONFIGS) as HeavyOpKind[];

export function registerResourceGovernorTools(
  mcp: McpServer,
  opts?: { ahaHomeDir?: string; activeAgentCount?: number }
): void {
  // ── get_resource_status ──────────────────────────────────────────────────
  mcp.registerTool('get_resource_status', {
    description:
      'Inspect host-machine resource status: free memory, disk, CPU load, active slots. ' +
      'All agents should call this before running heavy operations (build, tsc, test). ' +
      'Returns memory/disk/slot status so the agent can decide whether to proceed or wait.',
    title: 'Get Resource Status',
    inputSchema: {},
  }, async () => {
    try {
      const governor = getResourceGovernor({ ahaHomeDir: opts?.ahaHomeDir });
      const host = getHostHealth(opts?.activeAgentCount ?? 0, opts?.ahaHomeDir);
      const slots = governor.listSlots();

      const lines: string[] = [
        `Host Health (${new Date(host.checkedAt).toISOString()})`,
        `  Memory: ${Math.round(host.freeMem / 1_048_576)}MB free / ${Math.round(host.totalMem / 1_048_576)}MB total (${host.freeMemPct}%)`,
        `  Disk:   ${Math.round(host.diskFreeBytes / 1_073_741_824)}GB free / ${Math.round(host.diskTotalBytes / 1_073_741_824)}GB total (${host.diskFreePct}%)`,
        `  Load:   1m=${host.loadAvg1m} 5m=${host.loadAvg5m}`,
        `  Agents: ${opts?.activeAgentCount ?? 'unknown'}`,
        ``,
        `Heavy-Operation Slots:`,
      ];

      for (const slot of slots) {
        const status = slot.locked
          ? `🔒 LOCKED (pid=${slot.lockInfo?.pid}, path=${slot.lockInfo?.path})`
          : `🔓 FREE`;
        lines.push(
          `  ${slot.kind.padEnd(16)} ${status} — requires ~${slot.config.requiredMB}MB (safety=${slot.config.safetyFactor}x)`
        );
      }

      if (host.alerts.length > 0) {
        lines.push('');
        lines.push('Alerts:');
        for (const alert of host.alerts) {
          lines.push(`  ⚠️ ${alert}`);
        }
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        isError: false,
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error reading resource status: ${String(error)}` }],
        isError: true,
      };
    }
  });

  // ── acquire_heavy_op_slot ────────────────────────────────────────────────
  mcp.registerTool('acquire_heavy_op_slot', {
    description:
      '⚠️ Acquire an exclusive slot for a heavy operation (tsc, build, pkgroll, expo, prisma, daemon_restart, vitest). ' +
      'Refuses if insufficient memory or another slot of the same kind is already running. ' +
      'Always call release_heavy_op_slot when done.',
    title: 'Acquire Heavy Operation Slot',
    inputSchema: {
      kind: z.enum(HEAVY_OP_KINDS as [HeavyOpKind, ...HeavyOpKind[]]).describe('Type of heavy operation'),
      projectDir: z.string().optional().describe('Project directory (for lock metadata)'),
    },
  }, async (args) => {
    try {
      const governor = getResourceGovernor({ ahaHomeDir: opts?.ahaHomeDir });
      const result = governor.acquire(args.kind as HeavyOpKind, args.projectDir);

      if (result.granted) {
        return {
          content: [{
            type: 'text',
            text: `✅ Slot acquired for ${args.kind}. Free mem: ${result.freeMemMB}MB, required: ${result.requiredMemMB}MB. Lock file: ${result.lockFile}`,
          }],
          isError: false,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `❌ Slot denied for ${args.kind}. ${result.reason}`,
        }],
        isError: true,
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error acquiring slot: ${String(error)}` }],
        isError: true,
      };
    }
  });

  // ── release_heavy_op_slot ────────────────────────────────────────────────
  mcp.registerTool('release_heavy_op_slot', {
    description:
      'Release a previously acquired heavy-operation slot. ' +
      'Safe to call even if no slot is held. Must be called after acquire_heavy_op_slot.',
    title: 'Release Heavy Operation Slot',
    inputSchema: {
      kind: z.enum(HEAVY_OP_KINDS as [HeavyOpKind, ...HeavyOpKind[]]).describe('Type of heavy operation'),
    },
  }, async (args) => {
    try {
      const governor = getResourceGovernor({ ahaHomeDir: opts?.ahaHomeDir });
      governor.release(args.kind as HeavyOpKind);

      return {
        content: [{
          type: 'text',
          text: `🔓 Slot released for ${args.kind}.`,
        }],
        isError: false,
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error releasing slot: ${String(error)}` }],
        isError: true,
      };
    }
  });
}
