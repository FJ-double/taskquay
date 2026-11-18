import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const requireApp = createRequire(process.argv[2]);
const { McpServer } = requireApp('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = requireApp('@modelcontextprotocol/sdk/server/stdio.js');
const z = requireApp('zod/v4');
const server = new McpServer({ name: 'acceptance-agent', version: '1.0.0' });
const text = value => ({ content: [{ type: 'text', text: value }] });
server.registerTool('Read', { inputSchema: { file_path: z.string(), offset: z.number().optional(), limit: z.number().optional() } },
  async ({ file_path, offset, limit }) => {
    const lines = (await readFile(file_path, 'utf8')).split('\n');
    const from = (offset ?? 1) - 1;
    return text(lines.slice(from, limit === undefined ? undefined : from + limit).join('\n'));
  });
server.registerTool('Bash', {}, async () => { throw new Error('The fixture does not execute commands.'); });
server.registerTool('Write', {}, async () => { throw new Error('The fixture does not write files.'); });
await server.connect(new StdioServerTransport());
