import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startAhaServer } from './index';

type StartedServer = Awaited<ReturnType<typeof startAhaServer>>;

async function callJsonTool(baseUrl: string, name: string, args: Record<string, unknown>) {
    const client = new Client(
        { name: 'runtime-adapter-e2e', version: '1.0.0' },
        { capabilities: { tools: {} } },
    );
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));

    try {
        await client.connect(transport);
        const response: any = await client.callTool({ name, arguments: args });
        const content = Array.isArray(response?.content) ? response.content : [];
        const textEntry = content.find((entry: any) => entry?.type === 'text' && typeof entry.text === 'string');

        expect(textEntry?.text).toBeTypeOf('string');
        return JSON.parse(textEntry.text);
    } finally {
        try { await client.close(); } catch { /* noop */ }
        try { await transport.close?.(); } catch { /* noop */ }
    }
}

async function listToolNames(baseUrl: string) {
    const client = new Client(
        { name: 'runtime-adapter-e2e-list', version: '1.0.0' },
        { capabilities: { tools: {} } },
    );
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));

    try {
        await client.connect(transport);
        const response = await client.listTools();
        return response.tools.map((tool) => tool.name).sort();
    } finally {
        try { await client.close(); } catch { /* noop */ }
        try { await transport.close?.(); } catch { /* noop */ }
    }
}

function createFakeClient(metadata: Record<string, unknown>) {
    const sessionId = typeof metadata.ahaSessionId === 'string'
        ? metadata.ahaSessionId
        : 'sess-runtime-adapter';
    return {
        sessionId,
        getMetadata: () => metadata,
        getAuthToken: () => 'test-token',
        sendClaudeSessionMessage: () => undefined,
    } as any;
}

function createFakeApi() {
    return {
        getArtifact: async () => null,
        getSession: async () => null,
    } as any;
}

async function startTestServer(input: {
    metadata: Record<string, unknown>;
    genomeSpec: Record<string, unknown>;
}): Promise<StartedServer> {
    return startAhaServer(
        createFakeApi(),
        createFakeClient(input.metadata),
        { current: input.genomeSpec as any },
    );
}

describe('runtime adapter E2E', () => {
    const startedServers: StartedServer[] = [];

    afterEach(() => {
        while (startedServers.length > 0) {
            const server = startedServers.pop();
            server?.stop();
        }
    });

    it('serves the progressive self-inspection chain over HTTP for Claude runtime truth', async () => {
        const server = await startTestServer({
            metadata: {
                role: 'supervisor',
                ahaSessionId: 'sess-runtime-adapter',
                specId: 'spec-supervisor',
                candidateId: 'spec:spec-supervisor',
                memberId: 'member-supervisor',
                executionPlane: 'bypass',
                flavor: 'claude',
                runtimeBuild: {
                    gitSha: '1234567890abcdef1234567890abcdef12345678',
                    branch: 'feature/runtime-build',
                    worktreeName: 'aha-cli-0330-max-redefine-login',
                    runtime: 'claude',
                    startedAt: 1_717_171_717_000,
                    mirrorContractVersion: 'runtime-mirror-v1',
                },
                tools: ['mcp__aha__get_self_view'],
                runtimePermissions: {
                    source: 'claude-runtime',
                    updatedAt: Date.now(),
                    permissionMode: 'acceptEdits',
                    allowedTools: ['get_self_view', 'list_tasks', 'create_task'],
                    disallowedTools: ['kill_agent'],
                },
            },
            genomeSpec: {
                baseRoleId: 'supervisor',
                displayName: 'Supervisor',
                behavior: { canSpawnAgents: true },
                authorities: ['agent.spawn'],
            },
        });
        startedServers.push(server);

        const toolNames = await listToolNames(server.url);
        expect(toolNames).toEqual(expect.arrayContaining([
            'get_self_view',
            'list_visible_tools',
            'explain_tool_access',
            'get_effective_permissions',
            'grant_tool_access',
            'revoke_tool_access',
        ]));

        const selfView = await callJsonTool(server.url, 'get_self_view', {
            section: 'overview',
            format: 'json',
        });
        expect(selfView).toMatchObject({
            section: 'overview',
            identity: {
                design: {
                    role: 'supervisor',
                    genomeName: 'Supervisor',
                    specId: 'spec-supervisor',
                    candidateId: 'spec:spec-supervisor',
                },
                binding: {
                    sessionId: 'sess-runtime-adapter',
                    memberId: 'member-supervisor',
                    executionPlane: 'bypass',
                    runtimeType: 'claude',
                },
            },
            runtime: {
                permissionMode: 'acceptEdits',
                build: {
                    gitSha: '1234567890abcdef1234567890abcdef12345678',
                    branch: 'feature/runtime-build',
                    worktreeName: 'aha-cli-0330-max-redefine-login',
                    runtime: 'claude',
                    startedAt: 1_717_171_717_000,
                    mirrorContractVersion: 'runtime-mirror-v1',
                },
            },
            tools: {
                summary: {
                    visibleCount: 1,
                    allowlistCount: 3,
                    deniedCount: 1,
                    hiddenCount: 2,
                },
                visible: ['get_self_view'],
                hidden: ['list_tasks', 'create_task'],
            },
        });

        const visibleTools = await callJsonTool(server.url, 'list_visible_tools', {});
        expect(visibleTools).toMatchObject({
            sessionId: 'sess-runtime-adapter',
            visibleInventoryKnown: true,
            total: 1,
            tools: [
                {
                    rawName: 'mcp__aha__get_self_view',
                    name: 'get_self_view',
                    surface: 'mcp',
                },
            ],
        });

        const access = await callJsonTool(server.url, 'explain_tool_access', {
            tool: 'create_task',
        });
        expect(access).toMatchObject({
            sessionId: 'sess-runtime-adapter',
            tool: 'create_task',
            normalizedTool: 'create_task',
            visible: false,
            allowlisted: true,
            denied: false,
            status: 'hidden_by_allowlist',
        });

        const permissions = await callJsonTool(server.url, 'get_effective_permissions', {});
        expect(permissions).toMatchObject({
            sessionId: 'sess-runtime-adapter',
            role: 'supervisor',
            capabilityComputation: 'derived',
            capabilityInputs: expect.arrayContaining([
                'genome.authorities',
                'member.authorities',
                'teamOverlay.authorities',
                'rolePredicates',
            ]),
            permissionMode: 'acceptEdits',
            allowedTools: ['get_self_view', 'list_tasks', 'create_task'],
            deniedTools: ['kill_agent'],
            visibleTools: ['get_self_view'],
            hiddenTools: ['list_tasks', 'create_task'],
        });
    });

    it('keeps Codex allowlist and visible inventory unknown over the HTTP adapter when runtime metadata does not surface them', async () => {
        const server = await startTestServer({
            metadata: {
                role: 'implementer',
                ahaSessionId: 'sess-runtime-codex',
                specId: 'spec-implementer',
                candidateId: 'spec:spec-implementer',
                executionPlane: 'bypass',
                flavor: 'codex',
                runtimeBuild: {
                    gitSha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
                    branch: 'feature/codex-runtime-build',
                    worktreeName: 'aha-cli-0330-max-redefine-login',
                    runtime: 'codex',
                    startedAt: 99,
                    mirrorContractVersion: 'runtime-mirror-v1',
                },
                runtimePermissions: {
                    source: 'codex-runtime',
                    updatedAt: Date.now(),
                    permissionMode: 'bypassPermissions',
                },
            },
            genomeSpec: {
                baseRoleId: 'implementer',
                displayName: 'Implementer',
                behavior: { canSpawnAgents: false },
                authorities: [],
            },
        });
        startedServers.push(server);

        const selfView = await callJsonTool(server.url, 'get_self_view', {
            section: 'overview',
            format: 'json',
        });
        expect(selfView).toMatchObject({
            runtime: {
                permissionMode: 'bypassPermissions',
                build: {
                    gitSha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
                    branch: 'feature/codex-runtime-build',
                    worktreeName: 'aha-cli-0330-max-redefine-login',
                    runtime: 'codex',
                    startedAt: 99,
                    mirrorContractVersion: 'runtime-mirror-v1',
                },
            },
            tools: {
                summary: {
                    visibleCount: null,
                    allowlistCount: null,
                    deniedCount: null,
                    hiddenCount: null,
                },
                visible: null,
                hidden: null,
            },
        });
        expect(selfView.gaps).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'runtime_visible_tools_unknown' }),
        ]));

        const visibleTools = await callJsonTool(server.url, 'list_visible_tools', {});
        expect(visibleTools).toMatchObject({
            sessionId: 'sess-runtime-codex',
            visibleInventoryKnown: false,
            total: null,
            tools: null,
        });

        const access = await callJsonTool(server.url, 'explain_tool_access', {
            tool: 'get_self_view',
        });
        expect(access).toMatchObject({
            sessionId: 'sess-runtime-codex',
            tool: 'get_self_view',
            visible: null,
            allowlisted: null,
            denied: null,
            status: 'unknown',
        });

        const permissions = await callJsonTool(server.url, 'get_effective_permissions', {});
        expect(permissions).toMatchObject({
            sessionId: 'sess-runtime-codex',
            role: 'implementer',
            capabilityComputation: 'derived',
            permissionMode: 'bypassPermissions',
            allowedTools: null,
            deniedTools: null,
            visibleTools: null,
            hiddenTools: null,
        });
        expect(permissions.warnings).toEqual(expect.arrayContaining([
            'Visible tool inventory unavailable in session metadata.',
            'Runtime allowlist snapshot unavailable in session metadata.',
            'Runtime denylist snapshot unavailable in session metadata.',
        ]));
    });

    it('flags legacy sessions that do not carry runtime build metadata', async () => {
        const server = await startTestServer({
            metadata: {
                role: 'implementer',
                ahaSessionId: 'sess-runtime-legacy',
                specId: 'spec-legacy',
                candidateId: 'spec:spec-legacy',
                executionPlane: 'mainline',
                flavor: 'claude',
                tools: ['mcp__aha__get_self_view'],
                runtimePermissions: {
                    source: 'claude-runtime',
                    updatedAt: Date.now(),
                    permissionMode: 'acceptEdits',
                    allowedTools: ['get_self_view'],
                    disallowedTools: [],
                },
            },
            genomeSpec: {
                baseRoleId: 'implementer',
                displayName: 'Implementer',
                behavior: { canSpawnAgents: false },
                authorities: [],
            },
        });
        startedServers.push(server);

        const selfView = await callJsonTool(server.url, 'get_self_view', {
            section: 'overview',
            format: 'json',
        });

        expect(selfView.runtime.build).toBeNull();
        expect(selfView.gaps).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'runtime_build_unknown' }),
        ]));
    });
});
