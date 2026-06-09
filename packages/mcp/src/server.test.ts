import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createServer } from './server.js';

// Silent logger: tests must not write to stdout (it's the MCP channel).
const silentLogger = pino({ level: 'silent' });

async function connectClient() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(silentLogger);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe('chamba MCP server', () => {
  it('exposes exactly the workspace_show tool', async () => {
    const { client, server } = await connectClient();
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual(['chamba_workspace_show']);

    await server.close();
  });

  it('workspace_show returns a text result when no workspace.md exists', async () => {
    const { client, server } = await connectClient();

    const result = await client.callTool({ name: 'chamba_workspace_show', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;

    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toContain('workspace.md');

    await server.close();
  });
});
