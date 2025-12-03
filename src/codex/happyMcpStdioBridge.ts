/**
 * Happy MCP STDIO Bridge
 *
 * Minimal STDIO MCP server that bridges to a Happy HTTP MCP server.
 * It dynamically discovers tools from the HTTP server and exposes them via STDIO.
 *
 * Configure the target HTTP MCP URL via env var `HAPPY_HTTP_MCP_URL` or
 * via CLI flag `--url <http://127.0.0.1:PORT>`.
 *
 * Note: This process must not print to stdout as it would break MCP STDIO.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

function parseArgs(argv: string[]): { url: string | null } {
  let url: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' && i + 1 < argv.length) {
      url = argv[i + 1];
      i++;
    }
  }
  return { url };
}

async function main() {
  // Resolve target HTTP MCP URL
  const { url: urlFromArgs } = parseArgs(process.argv.slice(2));
  const baseUrl = urlFromArgs || process.env.HAPPY_HTTP_MCP_URL || '';

  if (!baseUrl) {
    // Write to stderr; never stdout.
    process.stderr.write(
      '[happy-mcp] Missing target URL. Set HAPPY_HTTP_MCP_URL or pass --url <http://127.0.0.1:PORT>\n'
    );
    process.exit(2);
  }

  // Connect to the HTTP MCP Server
  const client = new Client(
    { name: 'happy-stdio-bridge', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
  await client.connect(transport);

  // Fetch available tools from the HTTP server
  const toolsList = await client.listTools();

  // Create STDIO MCP server
  const server = new McpServer({
    name: 'Happy MCP Bridge',
    version: '1.0.0',
    description: 'STDIO bridge forwarding to Happy HTTP MCP',
  });

  // Dynamically register all tools found on the HTTP server
  for (const tool of toolsList.tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema as any,
      },
      async (args: any) => {
        try {
          const response = await client.callTool({ name: tool.name, arguments: args });
          // Pass-through response from HTTP server
          return response as any;
        } catch (error) {
          return {
            content: [
              { type: 'text', text: `Failed to execute ${tool.name}: ${error instanceof Error ? error.message : String(error)}` },
            ],
            isError: true,
          };
        }
      }
    );
  }

  // Start STDIO transport
  const stdio = new StdioServerTransport();
  await server.connect(stdio);
}

// Start and surface fatal errors to stderr only
main().catch((err) => {
  try {
    process.stderr.write(`[happy-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  } finally {
    process.exit(1);
  }
});
