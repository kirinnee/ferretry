import { describe, it } from 'bun:test';
import should from 'should';
import {
  claudeApproval,
  claudeServers,
  codexServers,
  codexTrusted,
  displayAddress,
  expandVariables,
  initializedNotification,
  initializeRequest,
  isFerretryLocalEntry,
  MCP_CHECK_PROTOCOL_VERSION,
  parseMessage,
  responseFor,
  serverNameOf,
  sseEvents,
  toolsListRequest,
  toolsPage,
} from '../../../src/lib/mcp-inventory/index.ts';
import { variable } from './support.ts';

describe('MCP declarations', () => {
  it('should read Claude’s transports the way Claude infers them', () => {
    // Arrange
    const document = {
      mcpServers: {
        typed: { type: 'sse', url: 'https://a.example/mcp' },
        bySuffix: { url: 'https://b.example/sse' },
        http: { url: 'https://c.example/mcp' },
        command: { command: 'npx', args: ['x', 1], env: { A: 'b', N: 2 } },
        broken: { args: [] },
        notObject: 'x',
      },
    };

    // Act
    const read = claudeServers(document);

    // Assert
    should(read.servers.map(server => `${server.name}:${server.transport}`)).deepEqual([
      'typed:sse',
      'bySuffix:sse',
      'http:http',
      'command:stdio',
    ]);
    should(read.servers[3]).containEql({ args: ['x'], env: { A: 'b' } });
    should(read.problems).deepEqual(['“broken” has neither a command nor a url', '“notObject” is not an object']);
    should(claudeServers({ mcpServers: [] }).problems).deepEqual(['"mcpServers" is not an object']);
    should(claudeServers(null)).deepEqual({ servers: [], problems: [] });
  });

  it('should read Codex’s tables, its bearer variable and its enabled switch', () => {
    // Act
    const read = codexServers({
      mcp_servers: {
        remote: { url: 'https://r.example/mcp', bearer_token_env_var: 'TOKEN', http_headers: { X: 'y' } },
        off: { command: 'srv', enabled: false },
        bad: 3,
      },
    });

    // Assert
    should(read.servers[0]).deepEqual({
      name: 'remote',
      transport: 'http',
      url: 'https://r.example/mcp',
      headers: { X: 'y' },
      bearerVariable: 'TOKEN',
    });
    should(read.servers[1]).containEql({ name: 'off', disabled: true });
    should(read.problems).deepEqual(['“bad” is not a table']);
  });

  it('should approve a .mcp.json server only when it is allowed AND the folder is trusted, and let a deny win', () => {
    // Arrange
    const trusted = { hasTrustDialogAccepted: true, enabledMcpjsonServers: ['a'], disabledMcpjsonServers: ['b'] };

    // Act / Assert
    should(claudeApproval('a', trusted, [])).equal('approved');
    should(claudeApproval('a', { ...trusted, hasTrustDialogAccepted: false }, [])).equal('pending');
    should(claudeApproval('b', trusted, [])).equal('disabled');
    should(claudeApproval('c', trusted, [])).equal('pending');
    should(claudeApproval('c', trusted, [{ enableAll: true, enabled: [], disabled: [] }])).equal('approved');
    should(claudeApproval('a', trusted, [{ enabled: [], disabled: ['a'] }])).equal('disabled');
    should(claudeApproval('a', undefined, [{ enabled: ['a'], disabled: [] }])).equal('pending');
  });

  it('should read a Codex project as trusted only when its config says so', () => {
    should(codexTrusted({ projects: { '/p': { trust_level: 'trusted' } } }, '/p')).be.true();
    should(codexTrusted({ projects: { '/p': { trust_level: 'untrusted' } } }, '/p')).be.false();
    should(codexTrusted({}, '/p')).be.false();
  });

  it('should recognise only Ferretry’s own local-scope delivery entries', () => {
    should(
      isFerretryLocalEntry({ headers: { Authorization: `Bearer ${variable('FY_MCP_DOCS_0A_TOKEN')}` } }),
    ).be.true();
    should(isFerretryLocalEntry({ headers: { Authorization: `Bearer ${variable('MY_TOKEN')}` } })).be.false();
    should(isFerretryLocalEntry({ headers: { Authorization: 'Bearer raw' } })).be.false();
    should(isFerretryLocalEntry({ command: 'x' })).be.false();
  });

  it('should show an address without its credentials, query or fragment', () => {
    should(displayAddress('https://user:pw@h.example:8443/mcp?key=1#x')).equal('https://h.example:8443/mcp');
    should(displayAddress('not a url')).equal('an address that does not parse');
  });
});

describe('MCP JSON-RPC', () => {
  it('should find the response by id among notifications and batches, and raise a server error', () => {
    // Arrange
    const messages = [{ jsonrpc: '2.0', method: 'notifications/progress' }, [{ id: 2, result: { tools: [] } }]];

    // Act / Assert
    should(responseFor(messages, 2)).deepEqual({ tools: [] });
    should(responseFor(messages, 3)).be.undefined();
    should(() => responseFor([{ id: 1, error: { message: 'nope' } }], 1)).throw('nope');
  });

  it('should read tool names and the next cursor', () => {
    should(toolsPage({ tools: [{ name: 'a' }, { nope: 1 }, { name: 'b' }], nextCursor: 'c2' })).deepEqual({
      names: ['a', 'b'],
      next: 'c2',
    });
    should(toolsPage({ tools: [], nextCursor: '' })).deepEqual({ names: [] });
  });

  it('should split an event stream into whole events and keep the unfinished one', () => {
    // Act
    const read = sseEvents(
      ': ping\r\nevent: endpoint\r\ndata: /messages?s=1\r\n\r\ndata: {"a":\ndata: 1}\n\ndata: partial',
    );

    // Assert
    should(read.events).deepEqual([
      { event: 'endpoint', data: '/messages?s=1' },
      { event: 'message', data: '{"a":\n1}' },
    ]);
    should(read.rest).equal('data: partial');
  });

  it('should expand variables and defaults as Claude does, and name the ones it could not fill', () => {
    // Arrange
    const missing = new Set<string>();

    // Act
    const text = expandVariables(`${variable('A')}-${variable('B:-dflt')}-${variable('C')}`, { A: 'a' }, missing);

    // Assert
    should(text).equal('a-dflt-');
    should([...missing]).deepEqual(['C']);
  });
});

describe('MCP check messages', () => {
  it('should open with initialize offering no capabilities, then initialized, then tools/list with its cursor', () => {
    should(JSON.parse(initializeRequest(1))).deepEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_CHECK_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'ferretry-check', version: '1' },
      },
    });
    should(JSON.parse(initializedNotification())).deepEqual({ jsonrpc: '2.0', method: 'notifications/initialized' });
    should(JSON.parse(toolsListRequest(2))).deepEqual({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    should(JSON.parse(toolsListRequest(3, 'c'))).deepEqual({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
      params: { cursor: 'c' },
    });
  });

  it('should read the server’s name, a nameless error, a result-less answer and text that is not JSON', () => {
    should(serverNameOf({ serverInfo: { name: 'x'.repeat(300) } })?.length).equal(256);
    should(serverNameOf({})).be.undefined();
    should(() => responseFor([{ id: 1, error: {} }], 1)).throw('the server answered with an error');
    should(responseFor([{ id: 1 }], 1)).deepEqual({});
    should(parseMessage('{"a":1}')).deepEqual({ a: 1 });
    should(parseMessage('not json')).be.undefined();
  });
});
