import { describe, it } from 'bun:test';
import should from 'should';
import {
  describeMcpServer,
  lookupMcpServer,
  type McpSourceServer,
  mcpSetupOf,
} from '../../../src/lib/shared-catalogs/mcp-source.ts';
import { stdio } from './support.ts';

const component = (extra: Partial<McpSourceServer> = {}): McpSourceServer => ({
  id: 'c1',
  name: 'docs',
  scope: 'component',
  harness: 'claude',
  declaration: null,
  ...extra,
});

describe('mcpSetupOf', () => {
  it('should convert a component command and keep its secret placeholder', () => {
    const result = mcpSetupOf(
      component({ component: { command: 'npx', args: ['x'], env: { API: '${secret:DOCS_KEY}' }, harness: 'codex' } }),
    );
    should(result.ok).be.true();
    if (result.ok) {
      should(result.setup).deepEqual({
        transport: 'command',
        command: 'npx',
        args: ['x'],
        env: { API: '${secret:DOCS_KEY}' },
      });
      should(result.harness).equal('codex');
    }
  });

  it('should convert a component URL, drop an OAuth clientSecret and say so', () => {
    const result = mcpSetupOf(
      component({
        component: {
          url: 'https://mcp.example.com/sse',
          auth: 'oauth',
          oauth: { clientId: 'abc', clientSecret: '${secret:CLIENT}', callbackPort: 4000 },
        },
      }),
    );
    should(result.ok).be.true();
    if (result.ok) {
      should(JSON.stringify(result.setup)).not.match(/CLIENT/u);
      should(result.problems[0]?.subject).equal('oauth.clientSecret');
      should(result.problems[0]?.reason).match(/never travels/u);
    }
    const plain = mcpSetupOf(component({ component: { url: 'https://mcp.example.com/sse' } }));
    should(plain.ok && plain.problems).deepEqual([]);
    const defaults = mcpSetupOf(component({ component: { command: 'run' } }));
    should(defaults.ok).be.true();
  });

  it('should refuse a component that left the configuration', () => {
    const result = mcpSetupOf(component());
    should(result).containEql({ ok: false });
  });

  it('should refuse a declaration that uses ${VAR} and say how to fix it', () => {
    const result = mcpSetupOf(stdio('leaky', { TOKEN: '${TOKEN}' }));
    should(result.ok).be.false();
    if (!result.ok) {
      should(result.reason).match(/environment TOKEN uses a/u);
      should(result.reason).match(/fleet MCP component/u);
    }
  });

  it('should refuse a declaration holding a raw-looking key, in the contract’s words', () => {
    const result = mcpSetupOf(stdio('keyed', { API: 'sk-live-0123456789abcdef0123456789abcdef' }));
    should(result.ok).be.false();
    if (!result.ok) should(result.reason).match(/looks like a raw secret/u);
  });

  it('should convert a plain stdio declaration', () => {
    const result = mcpSetupOf(stdio('files', { MODE: 'fast' }));
    should(result.ok && result.setup).deepEqual({
      transport: 'command',
      command: 'npx',
      args: ['-y', 'files'],
      env: { MODE: 'fast' },
    });
  });

  it('should convert a URL declaration, leaving out headers and a bearer variable with reasons', () => {
    const result = mcpSetupOf({
      id: 'u1',
      name: 'web',
      scope: 'user',
      harness: 'codex',
      declaration: {
        name: 'web',
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer x' },
        bearerVariable: 'WEB_TOKEN',
        oauth: { clientId: 'client', callbackPort: 5000 },
      },
    });
    should(result.ok).be.true();
    if (result.ok) {
      should(result.problems.map(problem => problem.subject)).deepEqual(['headers', 'bearer_token_env_var']);
      should(result.setup).containEql({ transport: 'url', auth: 'oauth' });
    }
    const bare = mcpSetupOf({
      id: 'u2',
      name: 'web2',
      scope: 'user',
      harness: 'claude',
      declaration: {
        name: 'web2',
        transport: 'sse',
        url: 'https://mcp.example.com/sse',
        headers: {},
        oauth: { clientId: 'c' },
      },
    });
    should(bare.ok).be.true();
    const noOauth = mcpSetupOf({
      id: 'u3',
      name: 'web3',
      scope: 'user',
      harness: 'claude',
      declaration: { name: 'web3', transport: 'http', url: 'https://mcp.example.com/', headers: {} },
    });
    should(noOauth.ok && noOauth.problems).deepEqual([]);
  });

  it('should refuse Ferretry’s own server, a bad name and a missing declaration', () => {
    should((mcpSetupOf({ ...stdio('ferretry'), scope: 'ferretry' }) as { reason: string }).reason).match(
      /not shareable/u,
    );
    should((mcpSetupOf({ ...stdio('bad name') }) as { reason: string }).reason).match(/not a name/u);
    should((mcpSetupOf({ ...stdio('x'), declaration: null }) as { reason: string }).reason).match(/no declaration/u);
  });

  it('should refuse a setup the contract rejects, with the contract’s sentence', () => {
    const result = mcpSetupOf(component({ component: { url: 'ftp://nope' } }));
    should(result.ok).be.false();
    if (!result.ok) should(result.reason).match(/cannot be shared as it is/u);
    const rootless = mcpSetupOf(stdio('files', { A: 'x' }));
    should(rootless.ok).be.true();
  });
});

describe('lookupMcpServer', () => {
  const servers = [
    stdio('a'),
    { ...stdio('b'), id: 'b1' },
    { ...stdio('b'), id: 'b2', scope: 'project' as const },
    { ...stdio('own'), scope: 'ferretry' as const },
  ];

  it('should prefer an id, then a unique name, and never guess between twins', () => {
    should(lookupMcpServer(servers, 'b2')).containEql({ kind: 'found' });
    should(lookupMcpServer(servers, 'a')).containEql({ kind: 'found' });
    should(lookupMcpServer(servers, 'b').kind).equal('ambiguous');
    should(lookupMcpServer(servers, 'nope').kind).equal('unknown');
    should(lookupMcpServer(servers, 'own').kind).equal('unknown');
  });

  it('should describe a server with its scope and file', () => {
    should(describeMcpServer(stdio('a'))).equal('a (user, /home/me/.claude.json)');
    should(describeMcpServer({ ...stdio('a'), source: undefined })).equal('a (user)');
  });
});
