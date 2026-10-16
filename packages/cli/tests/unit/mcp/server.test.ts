import { describe, it } from 'bun:test';
import { AGENT_TOOL_NAMES, type AgentToolCall, type AgentToolResult } from '@ferretry/protocol';
import should from 'should';
import type { TerminalWait } from '../../../src/lib/agent-tools/client';
import { McpServer } from '../../../src/lib/mcp/server';
import { MCP_TOOLS } from '../../../src/lib/mcp/tools';

function harness(
  answer: (call: AgentToolCall | TerminalWait) => Promise<AgentToolResult> = async () => ({ summary: 'ok' }),
) {
  const calls: (AgentToolCall | TerminalWait)[] = [];
  const server = new McpServer(
    {
      call: async call => {
        calls.push(call);
        return await answer(call);
      },
      wait: async wait => {
        calls.push(wait);
        return await answer(wait);
      },
    },
    { name: 'ferretry', version: '9.9.9' },
  );
  const request = async (method: string, params?: unknown, id: number | string = 1) =>
    await server.handle({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
  return { server, calls, request };
}

const toolCall = (name: string, args?: Record<string, unknown>) => ({
  name,
  ...(args === undefined ? {} : { arguments: args }),
});

describe('McpServer — the protocol', () => {
  it('should agree the version a client asks for when it speaks it, and offer the newest otherwise', async () => {
    // Arrange
    const { request } = harness();

    // Act
    const agreed = await request('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
    const offered = await request('initialize', { protocolVersion: '1999-01-01' });
    const bare = await request('initialize');
    const odd = await request('initialize', 'not an object');

    // Assert
    should(agreed).deepEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ferretry', version: '9.9.9' },
      },
    });
    should(offered).match({ result: { protocolVersion: '2025-06-18' } });
    should(bare).match({ result: { protocolVersion: '2025-06-18' } });
    should(odd).match({ result: { protocolVersion: '2025-06-18' } });
  });

  it('should answer a ping, and never answer a notification', async () => {
    const { server, request } = harness();
    should(await request('ping', undefined, 'p1')).deepEqual({ jsonrpc: '2.0', id: 'p1', result: {} });
    should(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).be.undefined();
    should(
      await server.handle({ jsonrpc: '2.0', method: 'tools/call', params: toolCall('terminal_list') }),
    ).be.undefined();
  });

  it('should refuse what is not a request, and a method it does not have', async () => {
    const { server, request } = harness();
    should(await server.handle('hello')).deepEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32_600, message: 'not a JSON-RPC 2.0 request' },
    });
    should(await server.handle({ jsonrpc: '1.0', id: 7, method: 'ping' })).match({ id: 7, error: { code: -32_600 } });
    should(await server.handle({ id: { nested: true }, method: 'ping' })).match({ id: null });
    should(await server.handle([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).match({
      id: null,
      error: { code: -32_600 },
    });
    should(await request('resources/list')).deepEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32_601, message: 'this server has no method resources/list' },
    });
  });
});

describe('McpServer — the tools', () => {
  it('should list every tool once, under a name a provider accepts, with an object input schema', async () => {
    // Arrange
    const { request } = harness();

    // Act
    const answer = (await request('tools/list')) as {
      result: { tools: { name: string; inputSchema: { type: string } }[] };
    };

    // Assert
    const names = answer.result.tools.map(tool => tool.name);
    should(names).deepEqual(AGENT_TOOL_NAMES.map(name => name.replace('.', '_')));
    should(names.every(name => /^[a-zA-Z0-9_-]{1,64}$/u.test(name))).be.true();
    should(answer.result.tools.every(tool => tool.inputSchema.type === 'object')).be.true();
    should(MCP_TOOLS.map(tool => tool.tool)).deepEqual([...AGENT_TOOL_NAMES]);
  });

  it('should send each tool as its wire call, and answer with the daemon’s words', async () => {
    // Arrange
    const { calls, request } = harness(async () => ({ summary: 'Opened %terminal:dev.', output: 'ready' }));

    // Act
    const answer = await request('tools/call', toolCall('terminal_open', { name: 'dev', command: 'bun dev' }));
    await request('tools/call', toolCall('browser_list'));
    await request('tools/call', toolCall('browser_open', { name: 'private', incognito: true }));
    await request('tools/call', toolCall('browser_read', { name: 'app', mode: 'a11y', tool: 'terminal.close' }));

    // Assert
    should(answer).deepEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'Opened %terminal:dev.\nready' }] },
    });
    // The tool is the one the client called, whatever an argument claimed.
    should(calls).deepEqual([
      { tool: 'terminal.open', name: 'dev', command: 'bun dev' },
      { tool: 'browser.list' },
      { tool: 'browser.open', name: 'private', incognito: true },
      { tool: 'browser.read', name: 'app', mode: 'a11y' },
    ]);
  });

  it('should return a screenshot as an image the model can see', async () => {
    const { request } = harness(async () => ({
      summary: 'A screenshot of %browser:app.',
      screenshotBase64: 'iVBORw0KGgo=',
    }));
    should(await request('tools/call', toolCall('browser_screenshot', { name: 'app' }))).match({
      result: {
        content: [
          { type: 'text', text: 'A screenshot of %browser:app.' },
          { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        ],
      },
    });
  });

  it('should wait for text or for exit within a total budget, and refuse anything else', async () => {
    // Arrange
    const { calls, request } = harness(async () => ({ summary: 'The text appeared.', matched: true }));

    // Act
    await request('tools/call', toolCall('terminal_wait', { name: 'dev', text: 'ready', timeoutMs: 90_000 }));
    await request('tools/call', toolCall('terminal_wait', { name: 'dev', exit: true }));
    const neither = await request('tools/call', toolCall('terminal_wait', { name: 'dev' }));
    const tooLong = await request(
      'tools/call',
      toolCall('terminal_wait', { name: 'dev', exit: true, timeoutMs: 600_000 }),
    );

    // Assert
    should(calls).deepEqual([
      { name: 'dev', text: 'ready', totalMs: 90_000 },
      { name: 'dev', exit: true, totalMs: 10_000 },
    ]);
    should(neither).match({
      result: {
        isError: true,
        content: [{ type: 'text', text: 'give "text" to wait for, or "exit": true — one of them' }],
      },
    });
    should(tooLong).match({ result: { isError: true, content: [{ text: /^timeoutMs: /u }] } });
  });

  it('should hand a refusal back as a tool error the model reads, not as a protocol error', async () => {
    // Arrange
    const { request } = harness(async () => {
      throw new Error('A person has taken over %terminal:dev; wait or ask them.');
    });
    const thrown = harness(async () => {
      throw 'a bare string';
    });

    // Act
    const refused = await request('tools/call', toolCall('terminal_send', { name: 'dev', text: 'ls' }));
    const odd = await thrown.request('tools/call', toolCall('terminal_list'));

    // Assert
    should(refused).deepEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: 'A person has taken over %terminal:dev; wait or ask them.' }],
        isError: true,
      },
    });
    should(odd).match({ result: { isError: true, content: [{ text: 'a bare string' }] } });
  });

  it('should refuse arguments the call schema refuses — another session among them — before sending anything', async () => {
    // Arrange
    const { calls, request } = harness();

    // Act
    const badName = await request('tools/call', toolCall('terminal_open', { name: 'Dev Server' }));
    const elsewhere = await request('tools/call', toolCall('terminal_list', { sessionId: 'someone-else' }));
    const scheme = await request(
      'tools/call',
      toolCall('browser_navigate', { name: 'app', url: 'file:///etc/passwd' }),
    );

    // Assert
    should(calls).deepEqual([]);
    should(badName).match({ result: { isError: true, content: [{ text: /^name: a name is a lowercase letter/u }] } });
    should(elsewhere).match({ result: { isError: true } });
    should(scheme).match({
      result: { isError: true, content: [{ text: 'url: only http and https URLs can be opened' }] },
    });
  });

  it('should refuse a call to a tool it does not have, or with no tool at all', async () => {
    const { request } = harness();
    should(await request('tools/call', toolCall('shell_exec'))).deepEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32_602, message: 'there is no tool shell_exec' },
    });
    should(await request('tools/call', { arguments: {} })).match({ error: { code: -32_602 } });
  });
});
