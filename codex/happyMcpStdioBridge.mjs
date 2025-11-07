import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

function parseArgs(argv) {
  let url = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url" && i + 1 < argv.length) {
      url = argv[i + 1];
      i++;
    }
  }
  return { url };
}
async function main() {
  const { url: urlFromArgs } = parseArgs(process.argv.slice(2));
  const baseUrl = urlFromArgs || process.env.HAPPY_HTTP_MCP_URL || "";
  if (!baseUrl) {
    process.stderr.write(
      "[happy-mcp] Missing target URL. Set HAPPY_HTTP_MCP_URL or pass --url <http://127.0.0.1:PORT>\n"
    );
    process.exit(2);
  }
  let httpClient = null;
  async function ensureHttpClient() {
    if (httpClient) return httpClient;
    const client = new Client(
      { name: "happy-stdio-bridge", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);
    httpClient = client;
    return client;
  }
  const server = new McpServer({
    name: "Happy MCP Bridge",
    version: "1.0.0",
    description: "STDIO bridge forwarding to Happy HTTP MCP"
  });
  server.registerTool(
    "change_title",
    {
      description: "Change the title of the current chat session",
      title: "Change Chat Title",
      inputSchema: {
        title: z.string().describe("The new title for the chat session")
      }
    },
    async (args) => {
      try {
        const client = await ensureHttpClient();
        const response = await client.callTool({ name: "change_title", arguments: args });
        return response;
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to change chat title: ${error instanceof Error ? error.message : String(error)}`
            }
          ],
          isError: true
        };
      }
    }
  );
  const stdio = new StdioServerTransport();
  await server.connect(stdio);
}
main().catch((err) => {
  try {
    process.stderr.write(
      `[happy-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}
`
    );
  } finally {
    process.exit(1);
  }
});
