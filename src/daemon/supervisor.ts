/**
 * Supervisor intervention functions for daemon session management.
 * Provides compaction, resume, kill, and health-check capabilities
 * used by the daemon and supervisor MCP tools.
 */

import { logger } from '@/ui/logger';
import { TrackedSession } from './types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';

/**
 * Compact an agent's context by sending /compact command through daemon RPC.
 * For Claude: injects /compact into the session's message queue
 * For Codex: sends /compact through the session's stdin/RPC
 */
export async function compactAgent(
    pid: number,
    session: TrackedSession,
    daemonHttpPort: number
): Promise<{ success: boolean; error?: string }> {
    // POST to http://127.0.0.1:{daemonHttpPort}/session-command
    // body: { sessionId: session.ahaSessionId, command: '/compact' }
    // This is a NEW endpoint we'll need on controlServer.
    // For now, just implement the client side.
    try {
        const response = await fetch(`http://127.0.0.1:${daemonHttpPort}/session-command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: session.ahaSessionId,
                command: '/compact'
            }),
            signal: AbortSignal.timeout(10_000),
        });
        const result = await response.json() as { success?: boolean; error?: string };
        return { success: result.success ?? false, error: result.error };
    } catch (error) {
        return { success: false, error: String(error) };
    }
}

/**
 * Resume a Claude Code agent by killing and restarting with --resume flag.
 * The new session inherits the full conversation history.
 */
export async function resumeClaudeAgent(
    pid: number,
    session: TrackedSession,
    spawnSession: (opts: SpawnSessionOptions) => Promise<SpawnSessionResult>
): Promise<{ success: boolean; newSessionId?: string; error?: string }> {
    try {
        // 1. Get the session ID for --resume
        const sessionId = session.ahaSessionId;
        if (!sessionId) {
            return { success: false, error: 'No session ID available for resume' };
        }

        const metadata = session.ahaSessionMetadataFromLocalWebhook;

        // 2. Kill the old process gracefully
        logger.debug(`[Supervisor] Sending SIGTERM to PID ${pid}`);
        try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }

        // 3. Wait for process to exit
        await new Promise(resolve => setTimeout(resolve, 2000));

        // 4. Force kill if still alive
        try {
            process.kill(pid, 0);
            process.kill(pid, 'SIGKILL');
        } catch { /* dead */ }
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 5. Spawn new session with --resume
        // Note: SpawnSessionOptions doesn't have claudeArgs yet;
        // passing resume context via env for now until the option is added.
        const result = await spawnSession({
            directory: metadata?.path || process.cwd(),
            agent: 'claude',
            teamId: metadata?.teamId || metadata?.roomId,
            role: metadata?.role,
            sessionName: metadata?.name,
            env: {
                AHA_RESUME_SESSION_ID: sessionId,
            },
        });

        if (result.type === 'success') {
            return { success: true, newSessionId: result.sessionId };
        }
        return {
            success: false,
            error: result.type === 'error' ? result.errorMessage : `Unexpected result: ${result.type}`
        };
    } catch (error) {
        return { success: false, error: String(error) };
    }
}

/**
 * Resume a Codex agent by killing and recreating with compressed context.
 * Codex doesn't support --resume, so we pass context summary as prompt.
 */
export async function resumeCodexAgent(
    pid: number,
    session: TrackedSession,
    spawnSession: (opts: SpawnSessionOptions) => Promise<SpawnSessionResult>,
    contextSummary?: string
): Promise<{ success: boolean; newSessionId?: string; error?: string }> {
    try {
        const metadata = session.ahaSessionMetadataFromLocalWebhook;

        // 1. Kill old process
        logger.debug(`[Supervisor] Sending SIGTERM to Codex PID ${pid}`);
        try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
        await new Promise(resolve => setTimeout(resolve, 2000));
        try {
            process.kill(pid, 0);
            process.kill(pid, 'SIGKILL');
        } catch { /* dead */ }
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 2. Spawn new codex session with context as prompt
        const result = await spawnSession({
            directory: metadata?.path || process.cwd(),
            agent: 'codex',
            teamId: metadata?.teamId || metadata?.roomId,
            role: metadata?.role,
            sessionName: metadata?.name,
            env: {
                ...(contextSummary ? { AHA_AGENT_PROMPT: contextSummary } : {}),
            },
        });

        if (result.type === 'success') {
            return { success: true, newSessionId: result.sessionId };
        }
        return {
            success: false,
            error: result.type === 'error' ? result.errorMessage : `Unexpected result: ${result.type}`
        };
    } catch (error) {
        return { success: false, error: String(error) };
    }
}

/**
 * Kill an agent process.
 */
export async function killAgent(pid: number): Promise<{ success: boolean; error?: string }> {
    try {
        process.kill(pid, 'SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 2000));
        try {
            process.kill(pid, 0);
            process.kill(pid, 'SIGKILL');
        } catch { /* dead */ }
        return { success: true };
    } catch (error) {
        return { success: false, error: String(error) };
    }
}

/**
 * Check health of all tracked sessions.
 * Returns list of sessions that need intervention.
 */
export function checkSessionHealth(
    sessions: Map<number, TrackedSession>
): Array<{ pid: number; session: TrackedSession; issue: string; severity: 'low' | 'medium' | 'high' | 'critical' }> {
    const issues: Array<{
        pid: number;
        session: TrackedSession;
        issue: string;
        severity: 'low' | 'medium' | 'high' | 'critical';
    }> = [];

    for (const [pid, session] of sessions) {
        // Check if process is alive
        try {
            process.kill(pid, 0);
        } catch {
            issues.push({ pid, session, issue: 'process_dead', severity: 'critical' });
            continue;
        }

        // Future: check last activity time from metadata
        // Future: check session file size for context overflow
    }

    return issues;
}
