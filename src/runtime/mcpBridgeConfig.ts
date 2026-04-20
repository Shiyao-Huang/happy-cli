/**
 * Runtime-neutral MCP bridge config builder.
 *
 * Why this exists:
 * - Claude and Codex both consume the same Aha MCP server.
 * - Their transport differs (Claude=http, Codex=stdio bridge), but the logical
 *   server registry ("aha" + optional "aha-desktop") must stay in sync.
 * - This helper is the single source of truth for that mapping.
 */

export type RuntimeBridgeTarget = 'claude' | 'codex';

type ClaudeMcpServerConfig = {
    type: 'http';
    url: string;
};

type CodexMcpServerConfig = {
    type: 'stdio';
    command: string;
    args: string[];
};

export type RuntimeMcpServerConfig = ClaudeMcpServerConfig | CodexMcpServerConfig;

export function buildRuntimeAhaMcpServers(opts: {
    runtime: RuntimeBridgeTarget;
    ahaServerUrl: string;
    desktopMcpUrl?: string;
    bridgeCommand?: string;
}): Record<string, RuntimeMcpServerConfig> {
    const { runtime, ahaServerUrl, desktopMcpUrl, bridgeCommand } = opts;

    if (runtime === 'claude') {
        const servers: Record<string, RuntimeMcpServerConfig> = {
            aha: { type: 'http', url: ahaServerUrl },
        };
        if (desktopMcpUrl) {
            servers['aha-desktop'] = { type: 'http', url: desktopMcpUrl };
        }
        return servers;
    }

    if (!bridgeCommand) {
        throw new Error('buildRuntimeAhaMcpServers(runtime=codex) requires bridgeCommand');
    }

    const servers: Record<string, RuntimeMcpServerConfig> = {
        aha: {
            type: 'stdio',
            command: bridgeCommand,
            args: ['--url', ahaServerUrl],
        },
    };
    if (desktopMcpUrl) {
        servers['aha-desktop'] = {
            type: 'stdio',
            command: bridgeCommand,
            args: ['--url', desktopMcpUrl],
        };
    }
    return servers;
}

