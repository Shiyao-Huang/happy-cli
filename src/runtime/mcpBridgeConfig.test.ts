import { describe, expect, it } from 'vitest';
import { buildRuntimeAhaMcpServers } from './mcpBridgeConfig';

describe('buildRuntimeAhaMcpServers', () => {
    it('builds Claude HTTP MCP registry', () => {
        const servers = buildRuntimeAhaMcpServers({
            runtime: 'claude',
            ahaServerUrl: 'http://127.0.0.1:9001',
            desktopMcpUrl: 'http://127.0.0.1:9002',
        });

        expect(servers).toEqual({
            aha: { type: 'http', url: 'http://127.0.0.1:9001' },
            'aha-desktop': { type: 'http', url: 'http://127.0.0.1:9002' },
        });
    });

    it('builds Codex stdio MCP registry via bridge command', () => {
        const servers = buildRuntimeAhaMcpServers({
            runtime: 'codex',
            ahaServerUrl: 'http://127.0.0.1:9101',
            desktopMcpUrl: 'http://127.0.0.1:9102',
            bridgeCommand: '/tmp/aha-mcp.mjs',
        });

        expect(servers).toEqual({
            aha: {
                type: 'stdio',
                command: '/tmp/aha-mcp.mjs',
                args: ['--url', 'http://127.0.0.1:9101'],
            },
            'aha-desktop': {
                type: 'stdio',
                command: '/tmp/aha-mcp.mjs',
                args: ['--url', 'http://127.0.0.1:9102'],
            },
        });
    });

    it('throws when Codex bridge command is missing', () => {
        expect(() =>
            buildRuntimeAhaMcpServers({
                runtime: 'codex',
                ahaServerUrl: 'http://127.0.0.1:9201',
            }),
        ).toThrow('requires bridgeCommand');
    });
});

