/**
 * Agent Heartbeat System
 *
 * Detects silently dying agent sessions and enables task reassignment.
 * Each agent pings periodically; the Master monitors for stale agents.
 *
 * Solves P0-3: Agent sessions silently die (24 daemon restarts/day,
 * no heartbeat, orphaned processes).
 */

import { logger } from '@/ui/logger';

export type AgentHealthStatus = 'alive' | 'suspect' | 'dead';

export interface AgentHeartbeatEntry {
    agentId: string;
    role: string;
    lastSeen: number;
    status: AgentHealthStatus;
    assignedTasks: string[];
    /** Last reported context window usage (0-100). Undefined if never reported. */
    contextUsedPercent?: number;
}

export interface DeadAgentReport {
    agentId: string;
    role: string;
    lastSeen: number;
    orphanedTasks: string[];
    deadForMs: number;
}

/** Emitted when an agent's context usage exceeds a threshold. */
export interface ContextAlertReport {
    agentId: string;
    role: string;
    contextUsedPercent: number;
}

export class AgentHeartbeat {
    private agents: Map<string, AgentHeartbeatEntry> = new Map();
    private readonly timeoutMs: number;
    private readonly suspectMs: number;
    private checkInterval: ReturnType<typeof setInterval> | null = null;
    private onDeadAgentCallback: ((report: DeadAgentReport) => void) | null = null;
    private onContextAlertCallback: ((report: ContextAlertReport) => void) | null = null;
    /** Track agents that already had a context alert fired this monitoring cycle (avoid spam). */
    private contextAlertFired: Set<string> = new Set();

    /**
     * @param timeoutMs - Time after which an agent is considered dead.
     *                    Defaults to 60 seconds.
     * @param suspectMs - Time after which an agent is considered suspect.
     *                    Defaults to 45 seconds.
     */
    constructor(timeoutMs: number = 60_000, suspectMs: number = 45_000) {
        this.timeoutMs = timeoutMs;
        this.suspectMs = suspectMs;
    }

    /**
     * Register a callback for when a dead agent is detected.
     */
    onDeadAgent(callback: (report: DeadAgentReport) => void): void {
        this.onDeadAgentCallback = callback;
    }

    /**
     * Register a callback for when an agent's context exceeds a threshold.
     * Used to trigger auto-compact for critical roles (e.g., Master).
     */
    onContextAlert(callback: (report: ContextAlertReport) => void): void {
        this.onContextAlertCallback = callback;
    }

    /**
     * Record a heartbeat ping from an agent.
     * Call this every 30s from each agent.
     *
     * @param contextUsedPercent - Optional context window usage (0-100).
     *   When provided for a 'master' role and >= 70, triggers the contextAlert callback.
     */
    ping(agentId: string, role: string, assignedTasks: string[] = [], contextUsedPercent?: number): void {
        const existing = this.agents.get(agentId);
        this.agents.set(agentId, {
            agentId,
            role,
            lastSeen: Date.now(),
            status: 'alive',
            assignedTasks: assignedTasks.length > 0 ? assignedTasks : (existing?.assignedTasks ?? []),
            contextUsedPercent,
        });
        logger.debug(`[Heartbeat] Ping from ${agentId} (${role})${contextUsedPercent !== undefined ? ` ctx=${contextUsedPercent}%` : ''}`);

        // Auto-compact trigger: fire alert when Master context exceeds 70%
        const CONTEXT_ALERT_THRESHOLD = parseInt(process.env.AHA_CONTEXT_ALERT_THRESHOLD || '70', 10);
        if (
            contextUsedPercent !== undefined &&
            contextUsedPercent >= CONTEXT_ALERT_THRESHOLD &&
            role === 'master' &&
            !this.contextAlertFired.has(agentId) &&
            this.onContextAlertCallback
        ) {
            this.contextAlertFired.add(agentId);
            this.onContextAlertCallback({ agentId, role, contextUsedPercent });
        }

        // Reset alert state when context drops below threshold (e.g., after compact)
        if (contextUsedPercent !== undefined && contextUsedPercent < CONTEXT_ALERT_THRESHOLD) {
            this.contextAlertFired.delete(agentId);
        }
    }

    /**
     * Get all agents that have exceeded the timeout threshold.
     */
    getDeadAgents(): DeadAgentReport[] {
        const now = Date.now();
        const dead: DeadAgentReport[] = [];

        for (const [agentId, entry] of this.agents) {
            const elapsed = now - entry.lastSeen;
            if (elapsed > this.timeoutMs) {
                dead.push({
                    agentId,
                    role: entry.role,
                    lastSeen: entry.lastSeen,
                    orphanedTasks: entry.assignedTasks,
                    deadForMs: elapsed,
                });
            }
        }

        return dead;
    }

    /**
     * Get agents that are suspected of being unresponsive but not yet
     * confirmed dead.
     */
    getSuspectAgents(): AgentHeartbeatEntry[] {
        const now = Date.now();
        return Array.from(this.agents.values()).filter(entry => {
            const elapsed = now - entry.lastSeen;
            return elapsed > this.suspectMs && elapsed <= this.timeoutMs;
        });
    }

    /**
     * Get a snapshot of all tracked agents.
     */
    getAllAgents(): AgentHeartbeatEntry[] {
        const now = Date.now();
        return Array.from(this.agents.values()).map(entry => {
            const elapsed = now - entry.lastSeen;
            let status: AgentHealthStatus = 'alive';
            if (elapsed > this.timeoutMs) {
                status = 'dead';
            } else if (elapsed > this.suspectMs) {
                status = 'suspect';
            }
            return { ...entry, status };
        });
    }

    /**
     * Remove an agent from tracking (e.g., after confirmed termination).
     */
    removeAgent(agentId: string): string[] {
        const entry = this.agents.get(agentId);
        const orphanedTasks = entry?.assignedTasks ?? [];
        this.agents.delete(agentId);
        logger.debug(`[Heartbeat] Removed agent ${agentId}, orphaned tasks: ${orphanedTasks.join(', ') || 'none'}`);
        return orphanedTasks;
    }

    /**
     * Start periodic health checks.
     * Runs every `intervalMs` and invokes the dead agent callback.
     *
     * @param intervalMs - Check interval. Defaults to 30 seconds.
     */
    startMonitoring(intervalMs: number = 30_000): void {
        if (this.checkInterval) {
            return; // Already monitoring
        }

        this.checkInterval = setInterval(() => {
            const deadAgents = this.getDeadAgents();

            for (const report of deadAgents) {
                // Only report each dead agent once by marking it
                const entry = this.agents.get(report.agentId);
                if (entry && entry.status !== 'dead') {
                    entry.status = 'dead';
                    logger.debug(`[Heartbeat] Agent ${report.agentId} (${report.role}) declared dead after ${Math.round(report.deadForMs / 1000)}s`);

                    if (this.onDeadAgentCallback) {
                        this.onDeadAgentCallback(report);
                    }
                }
            }

            // Update suspect statuses
            const suspects = this.getSuspectAgents();
            for (const suspect of suspects) {
                if (suspect.status !== 'suspect') {
                    suspect.status = 'suspect';
                    logger.debug(`[Heartbeat] Agent ${suspect.agentId} (${suspect.role}) marked suspect`);
                }
            }
        }, intervalMs);

        logger.debug(`[Heartbeat] Monitoring started (check every ${intervalMs / 1000}s, timeout ${this.timeoutMs / 1000}s)`);
    }

    /**
     * Stop periodic health checks.
     */
    stopMonitoring(): void {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
            logger.debug('[Heartbeat] Monitoring stopped');
        }
    }

    /**
     * Get a summary string for logging or display.
     */
    getSummary(): string {
        const all = this.getAllAgents();
        if (all.length === 0) {
            return 'No agents tracked';
        }

        const alive = all.filter(a => a.status === 'alive').length;
        const suspect = all.filter(a => a.status === 'suspect').length;
        const dead = all.filter(a => a.status === 'dead').length;

        return `Agents: ${alive} alive, ${suspect} suspect, ${dead} dead (${all.length} total)`;
    }
}
