import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

const client = new Client({ name: 'probe', version: '1.0.0' }, { capabilities: { tools: {}, elicitation: {} } });
client.setNotificationHandler(z.object({ method: z.literal('codex/event'), params: z.object({ msg: z.any() }) }).passthrough(), (data) => {
  console.log('NOTIFY', JSON.stringify(data.params.msg).slice(0,4000));
});
const transport = new StdioClientTransport({ command: 'codex', args: ['mcp-server'], env: process.env });
await client.connect(transport);
console.log('CONNECTED');
const tools = await client.listTools();
console.log('TOOLS', tools.tools.map(t=>t.name));
const resp = await client.callTool({
  name: 'codex',
  arguments: {
    prompt: 'Reply exactly with PONG and nothing else.',
    sandbox: 'read-only',
    'approval-policy': 'never'
  }
});
console.log('RESP', JSON.stringify(resp).slice(0,8000));
await client.close();
