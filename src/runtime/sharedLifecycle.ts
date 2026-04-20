/**
 * Shared Session Lifecycle — Common session setup extracted from runClaude/runCodex
 *
 * Both runtimes share significant session initialization logic:
 * - Metadata construction from env vars
 * - API session creation
 * - Daemon notification
 * - Keep-alive management
 * - Permission mode resolution
 *
 * This module provides shared utilities to reduce duplication.
 */

import type { Metadata, AgentState } from '@/api/types';
import { buildRuntimeBuildMetadata } from '@/utils/runtimeBuild';
import { logger } from '@/ui/logger';
import type { RuntimeFlavor, PermissionMode as RuntimePermissionMode } from './types';

/**
 * Build session metadata from environment variables
 *
 * Extracted from runClaude.ts lines ~240-310 and runCodex.ts equivalent.
 * Both runtimes construct nearly identical metadata objects.
 */
export function buildSessionMetadataFromEnv(params: {
    workingDirectory: string;
    processStartedAt: number;
    machineId: string;
    flavor: RuntimeFlavor;
    sessionTag: string;
    startedBy?: 'daemon' | 'terminal';
    ahaHomeDir: string;
    ahaLibDir: string;
}): Metadata {
    const {
        workingDirectory,
        processStartedAt,
        machineId,
        flavor,
        sessionTag,
        startedBy,
        ahaHomeDir,
        ahaLibDir,
    } = params;

    const metadata: Metadata = {
        path: workingDirectory,
        host: require('node:os').hostname(),
        version: getPackageVersion(),
        os: require('node:os').platform(),
        machineId,
        homeDir: require('node:os').homedir(),
        ahaHomeDir,
        ahaLibDir,
        ahaToolsDir: require('node:path').resolve(ahaLibDir, 'tools', 'unpacked'),
        startedFromDaemon: startedBy === 'daemon',
        processStartedAt,
        hostPid: process.pid,
        startedBy: startedBy || 'terminal',
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor,
        sessionTag,
        runtimeBuild: buildRuntimeBuildMetadata({
            cwd: workingDirectory,
            runtime: flavor,
            startedAt: processStartedAt,
        }),
    };

    // Populate optional env-driven fields
    if (process.env.AHA_TEAM_MEMBER_ID) {
        (metadata as any).memberId = process.env.AHA_TEAM_MEMBER_ID;
    }
    if (process.env.AHA_AGENT_ROLE) {
        metadata.role = process.env.AHA_AGENT_ROLE;
    }
    if (process.env.AHA_CANDIDATE_ID) {
        (metadata as any).candidateId = process.env.AHA_CANDIDATE_ID;
    }
    if (process.env.AHA_SPEC_ID) {
        (metadata as any).specId = process.env.AHA_SPEC_ID;
    }
    if (process.env.AHA_CANDIDATE_IDENTITY_JSON) {
        try {
            (metadata as any).candidateIdentity = JSON.parse(process.env.AHA_CANDIDATE_IDENTITY_JSON);
        } catch {
            // Non-fatal
        }
    }

    const roomIdFromEnv = process.env.AHA_ROOM_ID;
    if (roomIdFromEnv) {
        metadata.teamId = roomIdFromEnv;
        (metadata as any).roomId = roomIdFromEnv;
    }

    const executionPlaneFromEnv = process.env.AHA_EXECUTION_PLANE as 'bypass' | 'mainline' | undefined;
    if (executionPlaneFromEnv) {
        metadata.executionPlane = executionPlaneFromEnv;
    }

    if (process.env.AHA_ROOM_NAME) {
        metadata.roomName = process.env.AHA_ROOM_NAME;
    }
    if (process.env.AHA_AGENT_MODEL) {
        (metadata as any).modelOverride = process.env.AHA_AGENT_MODEL;
    }
    if (process.env.AHA_FALLBACK_AGENT_MODEL) {
        (metadata as any).fallbackModelOverride = process.env.AHA_FALLBACK_AGENT_MODEL;
    }

    // Priority: AHA_SESSION_NAME > AHA_ROOM_NAME
    metadata.name = process.env.AHA_SESSION_NAME || process.env.AHA_ROOM_NAME;

    return metadata;
}

/**
 * Resolve permission mode from env var
 *
 * Handles the different permission mode strings between Claude and Codex runtimes.
 */
export function resolvePermissionMode(rawMode?: string): RuntimePermissionMode | undefined {
    if (!rawMode) {
        return undefined;
    }
    const normalized = rawMode.trim().toLowerCase();
    switch (normalized) {
        case 'default':
            return 'default';
        case 'plan':
            return 'plan';
        case 'accept':
        case 'accept-edits':
        case 'acceptedits':
            return 'acceptEdits';
        case 'read-only':
        case 'readonly':
            return 'read-only';
        case 'safe-yolo':
        case 'safe_yolo':
        case 'safe':
            return 'safe-yolo';
        case 'yolo':
        case 'bypass':
        case 'bypasspermissions':
        case 'danger':
            return 'bypassPermissions';
        default:
            logger.debug(`[Runtime] Ignoring unknown permission mode: ${rawMode}`);
            return undefined;
    }
}

/**
 * Get package version from package.json
 */
function getPackageVersion(): string {
    try {
        // @ts-ignore — dynamic import for package.json
        return require('../../package.json').version;
    } catch {
        return 'unknown';
    }
}
