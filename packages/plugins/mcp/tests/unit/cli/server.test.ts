import { describe, it } from 'bun:test';
import should from 'should';
import { McpServer, type McpToolResult } from '../../../cli/lib/serve/server.ts';
import { MCP_TOOLS } from '../../../cli/lib/serve/tools.ts';

type Call = { readonly name: string; readonly args: Readonly<Record<string, unknown>> };

function harness(answer: (call: Call) => Promise<McpToolResult> = async () => ({ text: 'ok' }), instructions?: string) {
  const calls: Call[] = [];
  const server = new McpServer(
    {
      call: async (name, args) => {
        calls.push({ name, args });
        return await answer({ name, args });
      },
    },
    { name: 'ferretry', version: '9.9.9', ...(instructions === undefined ? {} : { instructions }) },
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
    const { request } = harness();
    const agreed = await request('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
    should(agreed).deepEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ferretry', version: '9.9.9' },
      },
    });
    should(await harness(undefined, 'One line.').request('initialize')).match({
      result: { instructions: 'One line.' },
    });
    should(await request('initialize', { protocolVersion: '1999-01-01' })).match({
      result: { protocolVersion: '2025-06-18' },
    });
    should(await request('initialize')).match({ result: { protocolVersion: '2025-06-18' } });
    should(await request('initialize', 'not an object')).match({ result: { protocolVersion: '2025-06-18' } });
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
    should(await request('resources/list')).deepEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32_601, message: 'this server has no method resources/list' },
    });
  });
});

describe('McpServer — the tools', () => {
  it('should list every built tool with its description and schema, and none that is not built', async () => {
    const { request } = harness();
    const answer = (await request('tools/list')) as { result: { tools: { name: string; inputSchema: object }[] } };
    const names = answer.result.tools.map(tool => tool.name);
    for (const name of [
      'terminal_open',
      'browser_screenshot',
      'config_read',
      'lessons_suggest',
      'search_work',
      'card_progress',
      'instructions',
      'input_wait',
      'account_hint',
      'account_propose',
      'task_plan',
    ])
      should(names).containEql(name);
    for (const name of ['secure_copy', 'secure_list', 'secure_discard', 'secure_paste'])
      should(names).not.containEql(name);
    should(new Set(names).size).equal(names.length);
    should(answer.result.tools).have.length(MCP_TOOLS.length);
    for (const tool of answer.result.tools) should(tool.inputSchema).have.property('type', 'object');
  });

  it('should pass a call to the tool of that name with its arguments, and answer its text', async () => {
    const { request, calls } = harness(async () => ({ text: 'Opened %terminal:dev.' }));
    const answer = await request('tools/call', toolCall('terminal_open', { name: 'dev', command: 'bun dev' }));
    should(calls).eql([{ name: 'terminal_open', args: { name: 'dev', command: 'bun dev' } }]);
    should(answer).deepEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'Opened %terminal:dev.' }] },
    });
  });

  it('should drop a flag that is only ever "on" when a model sends it false, here and one level down', async () => {
    const { request, calls } = harness();
    await request('tools/call', toolCall('browser_open', { name: 'app', incognito: false }));
    await request('tools/call', toolCall('browser_click', { name: 'app', ref: 'e1', double: true }));
    await request(
      'tools/call',
      toolCall('browser_emulate', {
        name: 'app',
        media: { print: false, colorScheme: 'dark' },
        network: { offline: false },
      }),
    );
    should(calls.map(call => call.args)).eql([
      { name: 'app' },
      { name: 'app', ref: 'e1', double: true },
      { name: 'app', media: { colorScheme: 'dark' }, network: {} },
    ]);
  });

  it('should carry isError with the daemon’s own sentence, not a protocol error', async () => {
    const { request } = harness(async () => ({
      text: 'A person has taken over %terminal:dev; wait or ask them.',
      isError: true,
    }));
    should(await request('tools/call', toolCall('terminal_send', { name: 'dev', text: 'ls' }))).deepEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: 'A person has taken over %terminal:dev; wait or ask them.' }],
        isError: true,
      },
    });
  });

  it('should turn a thrown refusal into an isError result with its sentence', async () => {
    const { request } = harness(async () => {
      throw new Error('The terminals plugin is turned off.');
    });
    should(await request('tools/call', toolCall('terminal_list'))).deepEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'The terminals plugin is turned off.' }], isError: true },
    });
  });

  it('should add an image part when the tool carried a picture in its data', async () => {
    const { request } = harness(async () => ({
      text: 'Took it.',
      data: { picture: { mime: 'image/jpeg', base64: 'AAAA' } },
    }));
    should(await request('tools/call', toolCall('browser_screenshot', { name: 'app' }))).deepEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          { type: 'text', text: 'Took it.' },
          { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
        ],
      },
    });
  });

  it('should render a config tool’s answer as the sentence, etag, files, issues and text (v4’s words)', async () => {
    const { request } = harness(async () => ({
      text: '{"raw":true}',
      data: {
        summary: 'machine.yaml read.',
        etag: 'e1',
        files: [{ path: 'machine.yaml', state: 'ok' }],
        issues: [{ path: 'voice.yaml', line: 3, column: 5, severity: 'error', message: 'bad key', fix: 'remove it' }],
        text: 'limit: 10\n',
      },
    }));
    const answer = (await request('tools/call', toolCall('config_read', { path: 'machine.yaml' }))) as {
      result: { content: { text: string }[] };
    };
    should(answer.result.content[0]?.text).equal(
      [
        'machine.yaml read.',
        'etag: e1',
        'machine.yaml (ok)',
        'voice.yaml:3:5 error: bad key — fix: remove it',
        'limit: 10\n',
      ].join('\n'),
    );
  });

  it('should fall back to the text when a config answer carries no readable data', async () => {
    const { request } = harness(async () => ({ text: 'Ferretry settings are not switched on.', isError: true }));
    should(await request('tools/call', toolCall('config_read'))).match({
      result: { content: [{ text: 'Ferretry settings are not switched on.' }], isError: true },
    });
  });

  it('should refuse a tool it does not list, including one that is not built, as invalid params', async () => {
    const { request, calls } = harness();
    should(await request('tools/call', toolCall('nonsense'))).match({ error: { code: -32_602 } });
    should(await request('tools/call', toolCall('secure_copy', { name: 'x', source: {} }))).match({
      error: { code: -32_602, message: 'there is no tool secure_copy' },
    });
    should(await request('tools/call', { arguments: {} })).match({ error: { code: -32_602 } });
    should(calls).have.length(0);
  });

  it('should refuse a wait that names neither text nor exit, or both, and a budget over two minutes, as a result', async () => {
    const { request, calls } = harness();
    for (const args of [
      { name: 'dev' },
      { name: 'dev', text: 'ready', exit: true },
      { name: 'dev', exit: true, timeoutMs: 120_001 },
      { name: 'dev', exit: true, other: 1 },
    ])
      should(await request('tools/call', toolCall('terminal_wait', args))).match({ result: { isError: true } });
    should(await request('tools/call', toolCall('browser_wait_for', { name: 'app', timeoutMs: 5 }))).match({
      result: { isError: true },
    });
    should(calls).have.length(0);
  });

  it('should pass a valid wait through with its budget, for the port to slice', async () => {
    const { request, calls } = harness();
    await request('tools/call', toolCall('terminal_wait', { name: 'dev', text: 'ready', timeoutMs: 90_000 }));
    await request('tools/call', toolCall('browser_wait_for', { name: 'app', text: 'Done', timeoutMs: 60_000 }));
    should(calls).eql([
      { name: 'terminal_wait', args: { name: 'dev', text: 'ready', timeoutMs: 90_000 } },
      { name: 'browser_wait_for', args: { name: 'app', text: 'Done', timeoutMs: 60_000 } },
    ]);
  });
});
