/**
 * Unified Runtime Types — Shared abstractions for Claude Code and Codex runtimes
 *
 * This module defines the common interface that both runtimes implement,
 * enabling a unified SDK bridge layer.
 */

/**
 * Runtime flavor identifier
 */
export type RuntimeFlavor = 'claude' | 'codex';

/**
 * Session mode for local/remote switching
 */
export type SessionMode = 'local' | 'remote';

/**
 * Permission mode for tool execution
 */
export type PermissionMode =
    | 'default'
    | 'acceptEdits'
    | 'bypassPermissions'
    | 'plan'
    | 'read-only'
    | 'safe-yolo'
    | 'yolo';

/**
 * Tool execution result
 */
export interface ToolResult {
    success: boolean;
    data?: unknown;
    error?: string;
    metadata?: {
        latencyMs?: number;
        adapter?: string;
        fallbackReason?: string;
    };
}

/**
 * Tool invocation request
 */
export interface ToolInvocation {
    toolName: string;
    arguments: Record<string, unknown>;
    requestId?: string;
}

/**
 * Session metadata shared across runtimes
 */
export interface RuntimeSessionMetadata {
    sessionId: string;
    flavor: RuntimeFlavor;
    mode: SessionMode;
    path: string;
    startTime: number;
    machineId?: string;
    ahaSessionId?: string;
}

/**
 * Runtime configuration
 */
export interface RuntimeConfig {
    flavor: RuntimeFlavor;
    path: string;
    permissionMode?: PermissionMode;
    startingMode?: SessionMode;
    allowedTools?: string[];
    disallowedTools?: string[];
    model?: string;
    fallbackModel?: string;
    maxTurns?: number;
    sessionTag?: string;
}

/**
 * Runtime lifecycle callbacks
 */
export interface RuntimeCallbacks {
    onModeChange?: (mode: SessionMode) => void;
    onThinkingChange?: (thinking: boolean) => void;
    onSessionReady?: (session: RuntimeSession) => void;
    onToolInvocation?: (invocation: ToolInvocation) => void;
}

/**
 * Runtime session interface — implemented by both Claude and Codex runtimes
 */
export interface RuntimeSession {
    readonly flavor: RuntimeFlavor;
    readonly metadata: RuntimeSessionMetadata;
    readonly config: RuntimeConfig;

    /**
     * Start the runtime session
     */
    start(): Promise<void>;

    /**
     * Stop the runtime session
     */
    stop(): Promise<void>;

    /**
     * Invoke a tool through the runtime
     */
    invokeTool(invocation: ToolInvocation): Promise<ToolResult>;

    /**
     * Send a message to the runtime
     */
    sendMessage(message: string): Promise<void>;

    /**
     * Switch between local and remote mode
     */
    switchMode(mode: SessionMode): Promise<void>;

    /**
     * Dispose of runtime resources
     */
    dispose(): void;
}

/**
 * Unified runtime factory options
 */
export interface RuntimeFactoryOptions extends RuntimeConfig {
    credentials: {
        apiKey?: string;
        accessToken?: string;
    };
    apiClient: unknown; // ApiClient — use unknown to avoid circular deps
    sessionClient: unknown; // ApiSessionClient
    callbacks?: RuntimeCallbacks;
    claudeEnvVars?: Record<string, string>;
    claudeArgs?: string[];
    mcpServers?: Record<string, unknown>;
    settingsPath?: string;
}

/**
 * Runtime factory — creates the appropriate runtime based on flavor
 */
export interface RuntimeFactory {
    create(options: RuntimeFactoryOptions): RuntimeSession;
}
