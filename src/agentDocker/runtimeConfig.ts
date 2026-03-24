import { existsSync, readFileSync } from 'fs';

type MaterializedEnvPayload = {
    values?: Record<string, string>;
};

type MaterializedMcpPayload = {
    mcpServers?: string[];
};

function readJsonFile<T>(path: string): T {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

export function readMaterializedEnvValues(envFilePath: string): Record<string, string> {
    if (!existsSync(envFilePath)) {
        return {};
    }

    const payload = readJsonFile<MaterializedEnvPayload>(envFilePath);
    return payload.values ?? {};
}

export function readMaterializedMcpServerNames(mcpConfigPath: string): string[] {
    if (!existsSync(mcpConfigPath)) {
        return [];
    }

    const payload = readJsonFile<MaterializedMcpPayload>(mcpConfigPath);
    return Array.isArray(payload.mcpServers) ? payload.mcpServers : [];
}

export function buildMaterializedSpawnEnv(opts: {
    settingsPath: string;
    envFilePath: string;
    mcpConfigPath: string;
}): Record<string, string> {
    return {
        ...readMaterializedEnvValues(opts.envFilePath),
        AHA_SETTINGS_PATH: opts.settingsPath,
        AHA_AGENT_ENV_FILE_PATH: opts.envFilePath,
        AHA_AGENT_MCP_CONFIG_PATH: opts.mcpConfigPath,
    };
}

export function filterMaterializedMcpServers<T>(
    serverMap: Record<string, T>,
    allowedServerNames?: string[],
): Record<string, T> {
    if (!allowedServerNames || allowedServerNames.length === 0) {
        return serverMap;
    }

    const allowed = new Set(allowedServerNames);
    return Object.fromEntries(
        Object.entries(serverMap).filter(([name]) => allowed.has(name)),
    );
}
