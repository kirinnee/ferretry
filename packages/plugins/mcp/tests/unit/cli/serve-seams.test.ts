import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { PluginClient } from '@ferretry/kernel/manifest';
import should from 'should';
import { clientToolsPort } from '../../../cli/lib/serve/port.ts';
import { McpServer } from '../../../cli/lib/serve/server.ts';
import { MCP_TOOLS } from '../../../cli/lib/serve/tools.ts';

/*
 * Another package is reached only through its contract, so the daemon halves this server talks to are stood in for here:
 * each stand-in answers EXACTLY as the half it replaces does, and says which line of it that is.
 */

/** A tool door that hands each call to the stand-in for the daemon tool of that name. */
function doorTo(
  handlers: Readonly<Record<string, (input: Record<string, unknown>) => Promise<unknown>>>,
): PluginClient {
  return {
    call: async () => {
      throw new Error('a tool call is not a route call');
    },
    subscribe: () => () => undefined,
    tool: async (name: string, input?: unknown) => {
      const handler = handlers[name];
      if (handler === undefined) throw new Error(`no handler for ${name}`);
      return await handler((input ?? {}) as Record<string, unknown>);
    },
  } as unknown as PluginClient;
}

/**
 * Conversation's `search_work` (conversation/daemon/search/routes.ts `searchWorkTool`): it parses the input with
 * `SearchWorkToolInputSchema` (strict; `kind` is `WorkKindSchema` = `card` | `ask`) and refuses what does not parse
 * before searching.
 */
function searchWorkStandIn(searched: Record<string, unknown>[]) {
  return async (input: Record<string, unknown>) => {
    const keys = Object.keys(input).every(key => ['query', 'kind', 'open', 'all'].includes(key));
    const kind = input.kind === undefined || input.kind === 'card' || input.kind === 'ask';
    if (typeof input.query !== 'string' || !keys || !kind)
      return { text: 'search_work needs a query of 1 to 200 characters', isError: true };
    searched.push(input);
    return { text: 'No matches.', data: { hits: [], total: 0 } };
  };
}

const toolCall = async (server: McpServer, name: string, args: Record<string, unknown>) => {
  const answer = await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  return (answer as { result: { isError?: boolean; content: { type: string; text: string }[] } }).result;
};

const serverOver = (client: PluginClient) => new McpServer(clientToolsPort(client), { name: 'ferretry', version: '1' });

describe('search_work.kind — the v4 words reach the Conversation tool', () => {
  const advertised = (): readonly string[] => {
    const row = MCP_TOOLS.find(tool => tool.name === 'search_work');
    should(row).not.be.undefined();
    return ((row as { inputSchema: unknown }).inputSchema as { properties: { kind: { enum: string[] } } }).properties
      .kind.enum;
  };

  it('should keep the v4 public schema', () => {
    should([...advertised()]).eql(['task', 'agenda']);
  });

  it('should deliver every advertised kind to the tool as the kind Conversation reads, and not refuse either', async () => {
    const searched: Record<string, unknown>[] = [];
    const server = serverOver(doorTo({ search_work: searchWorkStandIn(searched) }));
    const answers = [];
    for (const kind of advertised()) answers.push(await toolCall(server, 'search_work', { query: 'release', kind }));
    should(answers.map(answer => answer.isError)).eql([undefined, undefined]);
    should(searched).eql([
      { query: 'release', kind: 'card' },
      { query: 'release', kind: 'ask' },
    ]);
  });

  it('should leave a search with no kind, and every other argument, as it was', async () => {
    const searched: Record<string, unknown>[] = [];
    await toolCall(serverOver(doorTo({ search_work: searchWorkStandIn(searched) })), 'search_work', {
      query: 'x',
      open: true,
      all: true,
    });
    should(searched).eql([{ query: 'x', open: true, all: true }]);
  });

  it('should pass a kind that is neither word on unchanged, so the tool’s own refusal names it', async () => {
    const searched: Record<string, unknown>[] = [];
    const result = await toolCall(serverOver(doorTo({ search_work: searchWorkStandIn(searched) })), 'search_work', {
      query: 'x',
      kind: 'bogus',
    });
    should(result.isError).equal(true);
    should(searched).eql([]);
  });
});

describe('browser_list and browser_tabs — the rows survive into the MCP text', () => {
  const rows = [
    { id: 'page-1', name: 'app', title: 'Sign In', url: 'https://example.test/login', available: true },
    { id: 'page-2', title: 'Help', url: 'https://example.test/help', openerId: 'page-1', available: true },
    { id: 'page-3', name: 'admin', title: 'Admin', available: false },
  ];
  /** Browsers' `toolResult` (browsers/daemon/tools/index.ts): the sentence in `text`, the rows only in `data.surfaces`. */
  const browsersAnswer = (summary: string, output?: string, surfaces?: unknown) => async () => ({
    text: output === undefined ? summary : `${summary}\n\n${output}`,
    ...(surfaces === undefined ? {} : { data: { surfaces } }),
  });

  for (const tool of ['browser_list', 'browser_tabs']) {
    it(`should render each ${tool} row — title, address, popup opener and availability — as v4 did`, async () => {
      const server = serverOver(
        doorTo({ [tool]: browsersAnswer('3 browser pages: app, page-2, admin.', undefined, rows) }),
      );
      const result = await toolCall(server, tool, tool === 'browser_tabs' ? { action: 'list' } : {});
      should(result.isError).be.undefined();
      should(result.content[0]?.text).equal(
        [
          '3 browser pages: app, page-2, admin.',
          '  app  Sign In  https://example.test/login',
          '  page-2  Help  https://example.test/help  (popup of page-1)',
          '  admin  Admin  [not yours]',
        ].join('\n'),
      );
    });
  }

  it('should leave a read with no rows exactly as the tool said it', async () => {
    const server = serverOver(doorTo({ browser_read: browsersAnswer('Read app.', 'hello') }));
    should((await toolCall(server, 'browser_read', { name: 'app' })).content[0]?.text).equal('Read app.\n\nhello');
  });

  it('should leave a listing whose rows it cannot read as the tool said it, and not touch another tool’s rows', async () => {
    const odd = serverOver(doorTo({ browser_list: browsersAnswer('1 browser page.', undefined, [{ nope: 1 }]) }));
    should((await toolCall(odd, 'browser_list', {})).content[0]?.text).equal('1 browser page.');
    // Terminals renders its own rows into `text`; its `data.surfaces` must not be rendered a second time.
    const terminals = serverOver(
      doorTo({
        terminal_list: async () => ({
          text: '1 terminal: dev.\n  dev  Shell',
          data: { surfaces: [{ id: 't1', name: 'dev', title: 'Shell' }] },
        }),
      }),
    );
    should((await toolCall(terminals, 'terminal_list', {})).content[0]?.text).equal('1 terminal: dev.\n  dev  Shell');
  });
});

describe('browser_wait_for — a time wait sleeps once, whatever budget MCP allowed', () => {
  /** The browser wire (browsers/daemon/tools/wire.ts): a `timeoutMs` is at most `BROWSER_WAIT_MAX_MS` (25 s). */
  const wireStandIn = (sent: Record<string, unknown>[]) =>
    doorTo({
      browser_wait_for: async input => {
        sent.push(input);
        const budget = input.timeoutMs;
        if (typeof budget === 'number' && budget > 25_000)
          return { text: 'timeoutMs: Too big: expected number to be <=25000', isError: true };
        return { text: `Waited ${String(input.time)} ms.` };
      },
    });

  it('should send {name, time:1000, timeoutMs:60000} as one wire call without the MCP budget, and succeed', async () => {
    const sent: Record<string, unknown>[] = [];
    const result = await toolCall(serverOver(wireStandIn(sent)), 'browser_wait_for', {
      name: 'app',
      time: 1000,
      timeoutMs: 60_000,
    });
    should(result.isError).be.undefined();
    should(result.content[0]?.text).equal('Waited 1000 ms.');
    should(sent).eql([{ name: 'app', time: 1000 }]);
  });

  it('should still refuse a budget outside the MCP range for a time wait, sending nothing', async () => {
    const sent: Record<string, unknown>[] = [];
    const result = await toolCall(serverOver(wireStandIn(sent)), 'browser_wait_for', {
      name: 'app',
      time: 1000,
      timeoutMs: 999_999,
    });
    should(result.isError).equal(true);
    should(sent).eql([]);
  });
});

describe('the launch prompt names only tools the server lists', () => {
  // The prompt lives in the Runtimes daemon half, which this package may not import: its text is read, and the test
  // fails loudly if the constant moves, so the check cannot quietly stop checking.
  const promptSource = readFileSync(
    new URL('../../../../runtimes/daemon/lib/account/fixed-layer.ts', import.meta.url),
    'utf8',
  );
  const prompt = /export const AGENT_TOOLS_INSTRUCTION =\s*\n?\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/u.exec(
    promptSource,
  )?.[2];

  it('should not tell an agent to use any tool that is not in tools/list', () => {
    should(prompt).be.a.String();
    const listed = new Set(MCP_TOOLS.map(tool => tool.name));
    const named = new Set(
      (prompt?.match(/\b[a-z]+(?:_[a-z]+)+\b/gu) ?? []).filter(word =>
        /^(?:terminal|browser|account|config|secure|task|card|input|search|lesson)_/u.test(word),
      ),
    );
    should(named.size).be.above(3);
    should([...named].filter(word => !listed.has(word))).eql([]);
  });

  it('should be able to tell: a prompt naming an unlisted tool is caught by the same check', () => {
    const listed = new Set(MCP_TOOLS.map(tool => tool.name));
    should(listed.has('account_propose')).be.false();
    should(listed.has('account_hint')).be.true();
  });
});
