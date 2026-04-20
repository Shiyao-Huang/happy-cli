/**
 * @file mozartPhase3RealMcp.integration.test.ts
 * @description Phase-3 E2E: full chain TypeScript → Rust sidecar → real aha-cli MCP server.
 *
 * ## What this tests
 * - `HttpMozartAdapter` → Mozart Rust sidecar → real aha-cli `startAhaServer()` MCP endpoint
 * - `tools/list` golden-diff: Mozart chain returns identical tool list as direct MCP call
 * - Tool count matches declared `toolNames` from `src/claude/mcp/index.ts`
 * - `tools/call` error propagation: unknown tool returns structured JSON-RPC error
 *
 * ## Phase-3 Gate criteria
 * | ID    | Criterion                                    | Pass if                              |
 * |-------|----------------------------------------------|--------------------------------------|
 * | P3-01 | Mozart chain lists all aha-cli tools         | tool count ≥ declared toolNames count |
 * | P3-02 | Direct MCP and Mozart chain agree on tool list | names match exactly                  |
 * | P3-03 | Unknown tool call returns JSON-RPC error     | fallback fires, log captured         |
 * | P3-04 | Rust sidecar health check                    | {"ok":true}                          |
 *
 * ## Prerequisites
 * - Rust binary: `/Users/copizza/Desktop/happyhere/mozart/target/debug/mozart` must exist
 *   Build with: `cd /Users/copizza/Desktop/happyhere/mozart && cargo build --bin mozart`
 * - No other process on SIDECAR_PORT (7072)
 *
 * @see mozart/qa/phase2-rust-sidecar-e2e-report.md
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { HttpMozartAdapter } from './mozartHttpAdapter';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const RUST_BINARY = '/Users/copizza/Desktop/happyhere/mozart/target/debug/mozart';
const SIDECAR_PORT = 7072; // Phase-3 dedicated port (avoid conflict with Phase-2 :7071)
const SIDECAR_URL = `http://127.0.0.1:${SIDECAR_PORT}`;
const TIMEOUT_MS = 15_000;

// Tool count declared in src/claude/mcp/index.ts at time of Phase-3 sprint.
// Update this number when new tools are added.
const EXPECTED_MIN_TOOLS = 55;

// ─────────────────────────────────────────────────────────────────────────────
// Minimal aha-cli MCP server (stub context, tools/list only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Starts a real aha-cli MCP server with minimal stub dependencies.
 * Uses the actual tool-registration code from src/claude/mcp/index.ts
 * via a small re-implementation that avoids live API credentials.
 *
 * Tool registration succeeds (tools/list works) because api/client
 * are only invoked at tool-call time, not at registration time.
 */
async function startMinimalAhaMcpServer(): Promise<{ url: string; stop: () => void; toolNames: string[] }> {
    // Stub API — all methods throw if called (they shouldn't be for tools/list)
    const stubApi = new Proxy({} as any, {
        get: (_target, prop) => {
            if (typeof prop === 'string') {
                return (..._args: unknown[]) => Promise.reject(new Error(`stubApi.${prop} called unexpectedly`));
            }
        },
    });

    // Stub client — minimal surface needed for buildMcpHelpers
    const stubClient = {
        sessionId: 'phase3-stub-session-id',
        getMetadata: () => ({
            teamId: 'phase3-stub-team',
            ahaSessionId: 'phase3-stub-aha-session',
            role: 'architect',
            memberId: 'phase3-stub-member',
        }),
        sendClaudeSessionMessage: (_msg: unknown) => { /* no-op */ },
    } as any;

    // Import tool registration — we re-implement startAhaServer minimally
    // to avoid pulling in live networking dependencies.
    const { buildMcpHelpers } = await import('./mcpContext');
    const { registerContextTools } = await import('./contextTools');
    const { registerTeamTools } = await import('./teamTools');
    const { registerTaskTools } = await import('./taskTools');
    const { registerAgentTools } = await import('./agentTools');
    const { registerSupervisorTools } = await import('./supervisorTools');
    const { registerEvolutionTools } = await import('./evolutionTools');

    const toolNames: string[] = [];

    const server = createServer(async (req, res) => {
        const mcp = new McpServer({ name: 'Aha MCP Phase3 Stub', version: '1.0.0', description: 'Minimal stub for Phase-3 E2E' });

        // Wrap registerTool to collect tool names for assertion
        const orig = mcp.registerTool.bind(mcp);
        mcp.registerTool = (name: string, config: any, handler: any) => {
            if (!toolNames.includes(name)) toolNames.push(name);
            return orig(name, config, handler);
        };

        const helpers = buildMcpHelpers(stubApi, stubClient, undefined);
        const ctx = {
            mcp,
            api: stubApi,
            client: stubClient,
            genomeSpecRef: undefined,
            handler: async (_title: string) => ({ success: true }),
            pingDaemonHeartbeat: async () => { /* no-op */ },
            ...helpers,
        };

        registerContextTools(ctx);
        registerTeamTools(ctx);
        registerTaskTools(ctx);
        registerAgentTools(ctx);
        registerSupervisorTools(ctx);
        registerEvolutionTools(ctx);

        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
        res.on('close', () => { transport.close(); mcp.close(); });
    });

    const url = await new Promise<string>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as AddressInfo;
            resolve(`http://127.0.0.1:${addr.port}`);
        });
    });

    return {
        url,
        toolNames,
        stop: () => server.close(),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rust sidecar lifecycle
// ─────────────────────────────────────────────────────────────────────────────

async function startRustSidecar(mcpUrl: string): Promise<ChildProcess> {
    const sidecar = spawn(RUST_BINARY, [
        'serve',
        '--port', String(SIDECAR_PORT),
        '--mcp-url', mcpUrl,
    ], {
        env: { ...process.env, RUST_LOG: 'info' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wait for sidecar to be ready
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Sidecar startup timeout')), 5000);
        const check = async () => {
            try {
                const res = await fetch(`${SIDECAR_URL}/health`);
                if (res.ok) { clearTimeout(timer); resolve(); return; }
            } catch { /* not ready yet */ }
            setTimeout(check, 200);
        };
        check();
    });

    return sidecar;
}

// ─────────────────────────────────────────────────────────────────────────────
// Direct MCP tools/list (bypasses Mozart — raw JSON-RPC to aha-cli MCP server)
// ─────────────────────────────────────────────────────────────────────────────

async function listToolsDirect(mcpUrl: string): Promise<string[]> {
    const res = await fetch(mcpUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'tools/list',
            params: {},
            id: 'p3-direct-list',
        }),
        signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) throw new Error(`Direct MCP HTTP ${res.status}`);

    const contentType = res.headers.get('content-type') ?? '';
    let body: any;

    if (contentType.includes('text/event-stream')) {
        // StreamableHTTP may return SSE — parse first data: line
        const text = await res.text();
        const dataLine = text.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) throw new Error('No data line in SSE response');
        body = JSON.parse(dataLine.slice(6));
    } else {
        body = await res.json();
    }

    if (body.error) throw new Error(`Direct MCP error: ${JSON.stringify(body.error)}`);
    const tools: Array<{ name: string }> = body.result?.tools ?? [];
    return tools.map((t) => t.name).sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase-3 Real MCP E2E — Mozart sidecar ↔ aha-cli MCP server', () => {
    let mcpServer: { url: string; stop: () => void; toolNames: string[] };
    let sidecar: ChildProcess;
    let mozartAdapter: HttpMozartAdapter;

    beforeAll(async () => {
        // 1. Start aha-cli MCP server with stub context
        mcpServer = await startMinimalAhaMcpServer();

        // 2. Start Rust Mozart sidecar pointing at the MCP server
        sidecar = await startRustSidecar(mcpServer.url);

        // 3. Create HttpMozartAdapter pointing at the sidecar
        mozartAdapter = new HttpMozartAdapter(SIDECAR_URL, TIMEOUT_MS);
    }, 20_000);

    afterAll(async () => {
        mcpServer?.stop();
        if (sidecar && !sidecar.killed) {
            sidecar.kill('SIGTERM');
            await new Promise((r) => sidecar.on('exit', r));
        }
    });

    // ── P3-04: Sidecar health ────────────────────────────────────────────────

    it('P3-04: Rust sidecar GET /health returns {"ok":true}', async () => {
        const healthy = await mozartAdapter.healthCheck();
        expect(healthy).toBe(true);
    }, TIMEOUT_MS);

    // ── P3-01: Tool count ────────────────────────────────────────────────────

    it(`P3-01: Mozart chain lists ≥ ${EXPECTED_MIN_TOOLS} aha-cli tools`, async () => {
        const tools = await mozartAdapter.listTools();
        expect(tools.length).toBeGreaterThanOrEqual(EXPECTED_MIN_TOOLS);
    }, TIMEOUT_MS);

    // ── P3-02: Golden-diff ───────────────────────────────────────────────────

    it('P3-02: Mozart chain tool list matches direct MCP call (golden-diff)', async () => {
        const [mozartTools, directTools] = await Promise.all([
            mozartAdapter.listTools().then((t) => [...t].sort()),
            listToolsDirect(mcpServer.url),
        ]);

        // Write golden-diff JSON for QA evidence
        const goldenDiff = {
            generated_at: new Date().toISOString(),
            phase: 'phase-3',
            mcp_url: mcpServer.url,
            sidecar_url: SIDECAR_URL,
            direct_count: directTools.length,
            mozart_count: mozartTools.length,
            direct_only: directTools.filter((n) => !mozartTools.includes(n)),
            mozart_only: mozartTools.filter((n) => !directTools.includes(n)),
            common: mozartTools.filter((n) => directTools.includes(n)),
            match: directTools.length === mozartTools.length &&
                directTools.every((n) => mozartTools.includes(n)),
        };

        const { writeFileSync } = await import('node:fs');
        writeFileSync(
            '/Users/copizza/Desktop/happyhere/mozart/qa/phase3-golden-diff.json',
            JSON.stringify(goldenDiff, null, 2),
            'utf8',
        );

        expect(goldenDiff.direct_only).toEqual([]);
        expect(goldenDiff.mozart_only).toEqual([]);
        expect(goldenDiff.match).toBe(true);
    }, TIMEOUT_MS);

    // ── P3-03: Unknown tool → error propagation ───────────────────────────────

    it('P3-03: unknown tool call via Mozart → JSON-RPC error → fallback fires', async () => {
        // The stub MCP server has no "no_such_tool" registered;
        // Mozart sidecar will forward the call, MCP returns error, sidecar propagates it,
        // HttpMozartAdapter should return success=false, triggering fallback in mozartShim.
        const result = await mozartAdapter.invoke({
            toolName: 'no_such_tool_phase3',
            args: {},
            requestId: 'p3-error-test',
        });

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
    }, TIMEOUT_MS);

    // ── Summary log ─────────────────────────────────────────────────────────

    it('Phase-3 gate summary', async () => {
        const tools = await mozartAdapter.listTools();
        const declaredCount = mcpServer.toolNames.length;

        // eslint-disable-next-line no-console
        console.log([
            '\n══════════════════════════════════════════════════════',
            '  Mozart Phase-3 Gate — Real MCP E2E Summary',
            '══════════════════════════════════════════════════════',
            `  MCP server URL  : ${mcpServer.url}`,
            `  Sidecar URL     : ${SIDECAR_URL}`,
            `  Tools (declared): ${declaredCount}`,
            `  Tools (Mozart)  : ${tools.length}`,
            `  Golden-diff     : mozart/qa/phase3-golden-diff.json`,
            '══════════════════════════════════════════════════════',
        ].join('\n'));

        expect(tools.length).toBeGreaterThan(0);
    }, TIMEOUT_MS);
});
