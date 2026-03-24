import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { describe, expect, it } from 'vitest';

import {
    buildMaterializedSpawnEnv,
    filterMaterializedMcpServers,
    readMaterializedEnvValues,
    readMaterializedMcpServerNames,
} from './runtimeConfig';

describe('runtimeConfig', () => {
    it('reads materialized env values and builds spawn env with runtime paths', () => {
        const root = mkdtempSync(join(tmpdir(), 'aha-runtime-config-'));
        const settingsPath = join(root, 'settings.json');
        const envFilePath = join(root, 'env.json');
        const mcpConfigPath = join(root, 'mcp.json');

        writeFileSync(settingsPath, '{}', 'utf-8');
        writeFileSync(envFilePath, JSON.stringify({
            values: {
                OPENAI_API_KEY: 'test-key',
                AHA_ROOM_ID: 'team-1',
            },
        }, null, 2), 'utf-8');
        writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: ['aha'] }, null, 2), 'utf-8');

        expect(readMaterializedEnvValues(envFilePath)).toEqual({
            OPENAI_API_KEY: 'test-key',
            AHA_ROOM_ID: 'team-1',
        });
        expect(buildMaterializedSpawnEnv({ settingsPath, envFilePath, mcpConfigPath })).toEqual({
            OPENAI_API_KEY: 'test-key',
            AHA_ROOM_ID: 'team-1',
            AHA_SETTINGS_PATH: settingsPath,
            AHA_AGENT_ENV_FILE_PATH: envFilePath,
            AHA_AGENT_MCP_CONFIG_PATH: mcpConfigPath,
        });
    });

    it('reads mcp server names and filters built-in configs to the allowed set', () => {
        const root = mkdtempSync(join(tmpdir(), 'aha-runtime-config-mcp-'));
        const mcpConfigPath = join(root, 'mcp.json');
        mkdirSync(root, { recursive: true });

        writeFileSync(mcpConfigPath, JSON.stringify({
            mcpServers: ['aha-desktop'],
        }, null, 2), 'utf-8');

        expect(readMaterializedMcpServerNames(mcpConfigPath)).toEqual(['aha-desktop']);
        expect(filterMaterializedMcpServers({
            aha: { type: 'http', url: 'http://localhost:1' },
            'aha-desktop': { type: 'http', url: 'http://localhost:2' },
        }, ['aha-desktop'])).toEqual({
            'aha-desktop': { type: 'http', url: 'http://localhost:2' },
        });
    });
});
