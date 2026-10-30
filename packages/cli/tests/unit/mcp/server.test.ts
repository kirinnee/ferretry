import { describe, it } from 'bun:test';
import {
  AGENT_TOOL_NAMES,
  type AgentConfigToolCall,
  type AgentConfigToolResult,
  type AgentLessonToolCall,
  type AgentLessonToolResult,
  type AgentToolCall,
  type AgentToolResult,
} from '@ferretry/protocol';
import should from 'should';
import type { BrowserWait, TerminalWait } from '../../../src/lib/agent-tools/client';
import { McpServer } from '../../../src/lib/mcp/server';
import { MCP_CONFIG_TOOLS, MCP_LESSON_TOOLS, MCP_TOOLS } from '../../../src/lib/mcp/tools';

function harness(
  answer: (call: AgentToolCall | TerminalWait | BrowserWait) => Promise<AgentToolResult> = async () => ({
    summary: 'ok',
  }),
  options: {
    config?: (call: AgentConfigToolCall) => Promise<AgentConfigToolResult>;
    lessons?: (call: AgentLessonToolCall) => Promise<AgentLessonToolResult>;
    instructions?: string;
    environment?: Readonly<Record<string, string>>;
  } = {},
) {
  const calls: (AgentToolCall | TerminalWait | BrowserWait)[] = [];
  const configCalls: AgentConfigToolCall[] = [];
  const lessonCalls: AgentLessonToolCall[] = [];
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
      browserWait: async wait => {
        calls.push(wait);
        return await answer(wait);
      },
      config: async call => {
        configCalls.push(call);
        return await (options.config ?? (async () => ({ summary: 'ok' })))(call);
      },
      lessons: async call => {
        lessonCalls.push(call);
        return await (options.lessons ?? (async () => ({ summary: 'filed as a new lesson', outcome: 'filed' })))(call);
      },
    },
    {
      name: 'ferretry',
      version: '9.9.9',
      ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    },
    options.environment,
  );
  const request = async (method: string, params?: unknown, id: number | string = 1) =>
    await server.handle({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
  return { server, calls, configCalls, lessonCalls, request };
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
    should(await harness(undefined, { instructions: '# Set up' }).request('initialize')).match({
      result: { instructions: '# Set up' },
    });
    should((agreed as { result: object }).result).not.have.property('instructions');
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
    should(names).deepEqual([
      ...AGENT_TOOL_NAMES.map(name => name.replace('.', '_')),
      'config_read',
      'config_validate',
      'config_write',
      'lessons_suggest',
      'instructions',
    ]);
    should(names.every(name => /^[a-zA-Z0-9_-]{1,64}$/u.test(name))).be.true();
    should(answer.result.tools.every(tool => tool.inputSchema.type === 'object')).be.true();
    should(MCP_TOOLS.map(tool => tool.tool)).deepEqual([...AGENT_TOOL_NAMES]);
    should(MCP_CONFIG_TOOLS.map(tool => tool.configTool)).deepEqual(['config.read', 'config.validate', 'config.write']);
    should(MCP_LESSON_TOOLS.map(tool => tool.lessonTool)).deepEqual(['lessons.suggest']);
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

  it('should take a ref or a point in place of a selector, and read a false flag as one left out', async () => {
    // Arrange
    const { calls, request } = harness();

    // Act
    await request('tools/call', toolCall('browser_click', { name: 'app', ref: 'e12', double: false }));
    await request('tools/call', toolCall('browser_click', { name: 'app', x: 10, y: 20, double: true }));
    await request('tools/call', toolCall('browser_open', { name: 'app', incognito: false }));
    await request('tools/call', toolCall('browser_read', { name: 'app', mode: 'snapshot', boxes: false }));
    await request('tools/call', toolCall('browser_navigate', { name: 'app', history: 'back' }));

    // Assert
    should(calls).deepEqual([
      { tool: 'browser.click', name: 'app', ref: 'e12' },
      { tool: 'browser.click', name: 'app', x: 10, y: 20, double: true },
      { tool: 'browser.open', name: 'app' },
      { tool: 'browser.read', name: 'app', mode: 'snapshot' },
      { tool: 'browser.navigate', name: 'app', history: 'back' },
    ]);
  });

  it('should map the file tools, drop an overwrite that is off, and refuse an upload with no files', async () => {
    // Arrange
    const { calls, request } = harness(async () => ({ summary: 'ok' }));
    const attachment = `att_${'ef'.repeat(32)}`;

    // Act
    await request(
      'tools/call',
      toolCall('browser_upload', { name: 'app', selector: '#f', files: ['a.txt', { attachment }], mode: 'drop' }),
    );
    await request('tools/call', toolCall('browser_download', { name: 'app', id: 'dl-2', overwrite: false }));
    await request('tools/call', toolCall('browser_download', { name: 'app', saveAs: 'x.csv', overwrite: true }));
    await request('tools/call', toolCall('browser_pdf', { name: 'app', overwrite: false }));
    const empty = await request('tools/call', toolCall('browser_upload', { name: 'app', selector: '#f', files: [] }));

    // Assert
    should(calls).deepEqual([
      { tool: 'browser.upload', name: 'app', selector: '#f', files: ['a.txt', { attachment }], mode: 'drop' },
      { tool: 'browser.download', name: 'app', id: 'dl-2' },
      { tool: 'browser.download', name: 'app', saveAs: 'x.csv', overwrite: true },
      { tool: 'browser.pdf', name: 'app' },
    ]);
    should(empty).match({ result: { isError: true } });
  });

  it('should send a JPEG screenshot as a JPEG', async () => {
    const { request } = harness(async () => ({
      summary: 'A screenshot of %browser:app.',
      screenshotBase64: '/9j/4AAQ',
      screenshotFormat: 'jpeg',
    }));
    should(await request('tools/call', toolCall('browser_screenshot', { name: 'app', format: 'jpeg' }))).match({
      result: { content: [{ type: 'text' }, { type: 'image', data: '/9j/4AAQ', mimeType: 'image/jpeg' }] },
    });
  });

  it('should keep the tools list inside the budget every agent pays for it, every turn', () => {
    // Arrange — a runtime that loads every schema (Codex) carries this whole list in each prompt.
    const listed = [...MCP_TOOLS, ...MCP_CONFIG_TOOLS, ...MCP_LESSON_TOOLS].map(
      ({ name, description, inputSchema }) => ({ name, description, inputSchema }),
    );

    // Act
    const bytes = JSON.stringify(listed).length;
    const longest = Math.max(...listed.map(tool => tool.description.length));

    // Assert — 20.0 KB measured with refs, page lifecycle and file tools, ~27.4 KB once pointer and keys land
    // (#F199): a runtime that defers MCP schemas (Claude) pays only the names; one that loads them all
    // (Codex) pays this. 30 KB is the ceiling; owner-gated groups are listed only while they are on.
    should(bytes).be.below(30_000);
    should(longest).be.belowOrEqual(300);
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

  it('should map each page-lifecycle tool to its wire call', async () => {
    // Arrange
    const { calls, request } = harness();

    // Act
    await request('tools/call', toolCall('browser_dialog', { name: 'app', action: 'accept', promptText: 'yes' }));
    await request('tools/call', toolCall('browser_tabs', { action: 'adopt', id: 'page-7', as: 'popup' }));
    await request('tools/call', toolCall('browser_console', { name: 'app', level: 'warning', since: 4, limit: 20 }));
    await request('tools/call', toolCall('browser_network', { name: 'app', action: 'get', id: 'r12' }));
    await request(
      'tools/call',
      toolCall('browser_network', { name: 'app', action: 'list', filter: '/api', types: ['xhr', 'fetch'] }),
    );
    await request(
      'tools/call',
      toolCall('browser_emulate', {
        name: 'app',
        viewport: { width: 390, height: 844 },
        media: { colorScheme: 'dark', print: false },
        network: { offline: false, latency: 200 },
        reset: false,
      }),
    );
    await request('tools/call', toolCall('browser_emulate', { name: 'app', reset: true }));

    // Assert — a false on an on-only flag, nested ones included, is read as left out
    should(calls).deepEqual([
      { tool: 'browser.dialog', name: 'app', action: 'accept', promptText: 'yes' },
      { tool: 'browser.tabs', action: 'adopt', id: 'page-7', as: 'popup' },
      { tool: 'browser.console', name: 'app', level: 'warning', since: 4, limit: 20 },
      { tool: 'browser.network', name: 'app', action: 'get', id: 'r12' },
      { tool: 'browser.network', name: 'app', action: 'list', filter: '/api', types: ['xhr', 'fetch'] },
      {
        tool: 'browser.emulate',
        name: 'app',
        viewport: { width: 390, height: 844 },
        media: { colorScheme: 'dark' },
        network: { latency: 200 },
      },
      { tool: 'browser.emulate', name: 'app', reset: true },
    ]);
  });

  it('should hand browser_wait_for to the looping wait with its total budget, and refuse a bad one', async () => {
    // Arrange
    const { calls, request } = harness(async () => ({ summary: 'There.', matched: true }));

    // Act
    await request('tools/call', toolCall('browser_wait_for', { name: 'app', text: 'Welcome', timeoutMs: 90_000 }));
    await request('tools/call', toolCall('browser_wait_for', { name: 'app', selector: '#done', state: 'hidden' }));
    await request('tools/call', toolCall('browser_wait_for', { name: 'app', time: 2_000 }));
    const none = await request('tools/call', toolCall('browser_wait_for', { name: 'app' }));
    const tooLong = await request(
      'tools/call',
      toolCall('browser_wait_for', { name: 'app', text: 'x', timeoutMs: 600_000 }),
    );

    // Assert
    should(calls).deepEqual([
      { call: { tool: 'browser.wait_for', name: 'app', text: 'Welcome' }, totalMs: 90_000 },
      { call: { tool: 'browser.wait_for', name: 'app', selector: '#done', state: 'hidden' }, totalMs: 10_000 },
      { call: { tool: 'browser.wait_for', name: 'app', time: 2_000 }, totalMs: 10_000 },
    ]);
    should(none).match({ result: { isError: true } });
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

describe('McpServer — the config tools', () => {
  it('should route each config tool to the config port as its wire call, whatever an argument claimed', async () => {
    // Arrange
    const { calls, configCalls, request } = harness();

    // Act
    await request('tools/call', toolCall('config_read'));
    await request('tools/call', toolCall('config_read', { path: 'machine.yaml', tool: 'config.write' }));
    await request('tools/call', toolCall('config_validate', { path: 'warden.yaml', text: 'enabled: true\n' }));
    await request('tools/call', toolCall('config_write', { path: 'voice.yaml', text: '', etag: 'abc' }));

    // Assert
    should(calls).deepEqual([]);
    should(configCalls).deepEqual([
      { tool: 'config.read' },
      { tool: 'config.read', path: 'machine.yaml' },
      { tool: 'config.validate', path: 'warden.yaml', text: 'enabled: true\n' },
      { tool: 'config.write', path: 'voice.yaml', text: '', etag: 'abc' },
    ]);
  });

  it('should answer with the summary alone when there is nothing more to say', async () => {
    const { request } = harness();
    should(await request('tools/call', toolCall('config_read'))).deepEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'ok' }] },
    });
  });

  it('should render the summary, etag, files, located issues and text', async () => {
    // Arrange
    const { request } = harness(undefined, {
      config: async () => ({
        summary: 'Read 2 files.',
        etag: 'etag-9',
        files: [
          { path: 'machine.yaml', kind: 'machine', schema: 'machine', state: 'ok' },
          { path: 'warden.yaml', kind: 'warden', schema: 'warden', state: 'pending' },
        ],
        issues: [
          { path: 'machine.yaml', line: 3, column: 7, severity: 'error', message: 'not a thing', fix: 'make it one' },
          { path: 'voice.yaml', severity: 'warning', message: 'odd', fix: 'tidy it' },
        ],
        text: 'enabled: true\n',
      }),
    });

    // Act
    const answer = await request('tools/call', toolCall('config_read'));

    // Assert
    should(answer).deepEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          {
            type: 'text',
            text: [
              'Read 2 files.',
              'etag: etag-9',
              'machine.yaml (ok)',
              'warden.yaml (pending)',
              'machine.yaml:3:7 error: not a thing — fix: make it one',
              'voice.yaml warning: odd — fix: tidy it',
              'enabled: true\n',
            ].join('\n'),
          },
        ],
      },
    });
  });

  it('should refuse arguments the call schema refuses before asking the daemon', async () => {
    // Arrange
    const { configCalls, request } = harness();

    // Act
    const notAConfigFile = await request('tools/call', toolCall('config_validate', { path: 'notes.txt', text: '' }));
    const noText = await request('tools/call', toolCall('config_write', { path: 'voice.yaml' }));
    const huge = await request(
      'tools/call',
      toolCall('config_validate', { path: 'voice.yaml', text: 'x'.repeat(256 * 1024 + 1) }),
    );

    // Assert
    should(configCalls).deepEqual([]);
    should(notAConfigFile).match({
      result: { isError: true, content: [{ text: /^path: not a Ferretry configuration file/u }] },
    });
    should(noText).match({ result: { isError: true, content: [{ text: /^text: / }] } });
    should(huge).match({
      result: { isError: true, content: [{ text: /^text: a configuration file is at most 256 KiB/u }] },
    });
  });

  it('should hand a thrown refusal back as a tool error, not as a protocol error', async () => {
    // Arrange
    const refused = harness(undefined, {
      config: async () => {
        throw new Error('Agents may not change Ferretry settings on this machine.');
      },
    });
    const odd = harness(undefined, {
      config: async () => {
        throw 'a bare string';
      },
    });

    // Act + Assert
    should(await refused.request('tools/call', toolCall('config_read'))).deepEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: 'Agents may not change Ferretry settings on this machine.' }],
        isError: true,
      },
    });
    should(await odd.request('tools/call', toolCall('config_read'))).match({
      result: { isError: true, content: [{ text: 'a bare string' }] },
    });
  });
});

describe('McpServer — the lessons tool', () => {
  it('should route the call to the lessons port as its wire call, whatever an argument claimed', async () => {
    // Arrange
    const { calls, lessonCalls, request } = harness();

    // Act
    await request(
      'tools/call',
      toolCall('lessons_suggest', {
        rule: 'Run bun install inside the target package.',
        scope: 'global',
        tool: 'config.read',
      }),
    );

    // Assert
    should(calls).deepEqual([]);
    should(lessonCalls).deepEqual([
      { tool: 'lessons.suggest', rule: 'Run bun install inside the target package.', scope: 'global' },
    ]);
  });

  it('should answer with the daemon’s own sentence', async () => {
    const { request } = harness(undefined, {
      lessons: async () => ({ summary: 'merged into an existing lesson (now 3×)', outcome: 'merged', count: 3 }),
    });
    should(await request('tools/call', toolCall('lessons_suggest', { rule: 'a rule', scope: 'repo' }))).deepEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'merged into an existing lesson (now 3×)' }] },
    });
  });

  it('should refuse arguments the call schema refuses before asking the daemon', async () => {
    // Arrange
    const { lessonCalls, request } = harness();

    // Act
    const noScope = await request('tools/call', toolCall('lessons_suggest', { rule: 'a rule' }));
    const badScope = await request('tools/call', toolCall('lessons_suggest', { rule: 'a rule', scope: 'everyone' }));
    const tooLong = await request(
      'tools/call',
      toolCall('lessons_suggest', { rule: 'x'.repeat(501), scope: 'global' }),
    );

    // Assert
    should(lessonCalls).deepEqual([]);
    should(noScope).match({ result: { isError: true, content: [{ text: /^scope: /u }] } });
    should(badScope).match({ result: { isError: true, content: [{ text: /^scope: /u }] } });
    should(tooLong).match({ result: { isError: true, content: [{ text: /^rule: /u }] } });
  });

  it('should hand a thrown refusal back as a tool error, not as a protocol error', async () => {
    // Arrange
    const refused = harness(undefined, {
      lessons: async () => {
        throw new Error('no agent session credential here');
      },
    });
    const odd = harness(undefined, {
      lessons: async () => {
        throw 'a bare string';
      },
    });

    // Act + Assert
    should(
      await refused.request('tools/call', toolCall('lessons_suggest', { rule: 'a rule', scope: 'global' })),
    ).deepEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'no agent session credential here' }], isError: true },
    });
    should(await odd.request('tools/call', toolCall('lessons_suggest', { rule: 'a rule', scope: 'global' }))).match({
      result: { isError: true, content: [{ text: 'a bare string' }] },
    });
  });
});

describe('the instructions tool', () => {
  it('should answer from the launch environment it inherited, without calling the daemon', async () => {
    // Arrange — an interactive ferret launched with hypermedia on and Pack mode off.
    const { request, calls } = harness(async () => ({ summary: 'unused' }), {
      environment: { FY_SESSION_ID: 'session-7', FY_SESSION_MODE: 'interactive', FY_HYPERMEDIA: '1', FY_PACK: '0' },
    });

    // Act
    const answer = (await request('tools/call', toolCall('instructions'))) as {
      result: { content: { type: string; text: string }[] };
    };

    // Assert
    const text = answer.result.content[0]?.text ?? '';
    should(text).startWith('Sections ferret session-7 launched with (interactive):');
    should(text).containEql('✓ Hypermedia: on');
    should(text).containEql(
      '✗ Pack mode: off. The owner turns it on in Ferretry: open this ferret › Actions › Pack mode.',
    );
    should(calls).be.empty();
  });
});
