#!/usr/bin/env node
/**
 * Mozart Mock Proxy — minimal JSON-RPC 2.0 HTTP server for QA testing.
 *
 * Simulates the future Rust Mozart HTTP sidecar so the TypeScript
 * HttpMozartAdapter can be tested end-to-end without the Rust toolchain.
 *
 * Usage:
 *   node mozartMockProxy.mjs [--port 7070] [--mode normal|timeout|error|schema-mismatch]
 *
 * Modes:
 *   normal          — returns valid JSON-RPC results (default)
 *   timeout         — never responds (tests MOZART_TIMEOUT_MS enforcement)
 *   error           — returns JSON-RPC error on tools/call (R-001/R-002)
 *   schema-mismatch — returns malformed response (R-003)
 *   http-500        — returns HTTP 500 on every request
 */

import { createServer } from 'node:http';

// ─────────────────────────────────────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1] ?? 7070) || 7070;
const modeArg = args[args.indexOf('--mode') + 1] ?? 'normal';
const VALID_MODES = ['normal', 'timeout', 'error', 'schema-mismatch', 'http-500'];
const mode = VALID_MODES.includes(modeArg) ? modeArg : 'normal';

// ─────────────────────────────────────────────────────────────────────────────
// Fake tool registry
// ─────────────────────────────────────────────────────────────────────────────

const FAKE_TOOLS = [
    { name: 'send_team_message', description: 'Send a team message' },
    { name: 'create_task', description: 'Create a task' },
    { name: 'get_team_info', description: 'Get team info' },
];

// ─────────────────────────────────────────────────────────────────────────────
// JSON-RPC helpers
// ─────────────────────────────────────────────────────────────────────────────

function jsonRpcOk(id, result) {
    return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id, code, message) {
    return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Request dispatcher
// ─────────────────────────────────────────────────────────────────────────────

function dispatch(req) {
    const { method, params, id } = req;

    switch (method) {
        case 'health':
            return jsonRpcOk(id, { ok: true, mode, server: 'mozart-mock-proxy' });

        case 'tools/list':
            return jsonRpcOk(id, { tools: FAKE_TOOLS });

        case 'tools/call': {
            const toolName = params?.name ?? 'unknown';
            return jsonRpcOk(id, {
                content: [{ type: 'text', text: `[mock] ${toolName} executed` }],
                __mock__: true,
                toolName,
                receivedArgs: params?.arguments,
            });
        }

        default:
            return jsonRpcError(id, -32601, `Method not found: ${method}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP server
// ─────────────────────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
    // Mode: http-500
    if (mode === 'http-500') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
        return;
    }

    // Mode: timeout — never respond (simulates adapter_invoke_timeout)
    if (mode === 'timeout') {
        // Intentionally hang — let MOZART_TIMEOUT_MS trigger on the caller side
        return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
        let parsed;
        try {
            parsed = JSON.parse(body);
        } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(jsonRpcError('parse-error', -32700, 'Parse error'));
            return;
        }

        const id = parsed.id ?? 'unknown';

        // Mode: error — return JSON-RPC error for tools/call
        if (mode === 'error' && parsed.method === 'tools/call') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(jsonRpcError(id, -32000, 'mcp_schema_mismatch'));
            return;
        }

        // Mode: schema-mismatch — return non-JSON-RPC response
        if (mode === 'schema-mismatch') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ unexpected: 'schema', data: null }));
            return;
        }

        // Normal dispatch
        const response = dispatch(parsed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(response);
    });
});

server.listen(port, '127.0.0.1', () => {
    process.stdout.write(
        `[mozart-mock-proxy] Listening on http://127.0.0.1:${port} (mode=${mode})\n`
    );
});

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => { server.close(); process.exit(0); });
