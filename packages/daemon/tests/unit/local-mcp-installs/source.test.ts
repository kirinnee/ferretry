import { describe, it } from 'bun:test';
import should from 'should';
import { copiableMcp, type LocalMcpInventoryServer } from '../../../src/lib/local-mcp-installs/source.ts';
import { FAKE_VALUE, stdioServer } from './support.ts';

const http = (url: string, extra: Partial<LocalMcpInventoryServer> = {}): LocalMcpInventoryServer =>
  stdioServer({
    name: 'remote',
    declaration: { name: 'remote', transport: 'http', url, headers: {} },
    ...extra,
  });

const stdioWith = (env: Record<string, string>) =>
  stdioServer({ declaration: { name: 'search', transport: 'stdio', command: 'npx', args: ['x'], env } });

describe('what of an MCP server on this machine can be copied', () => {
  it('should turn every environment value into a placeholder named after the variable, never carrying a value', () => {
    const copied = copiableMcp(stdioServer());

    should(copied.ok).be.true();
    if (!copied.ok) return;
    should(copied.setup).deepEqual({
      transport: 'command',
      command: 'npx',
      args: ['-y', 'search-mcp'],
      env: { API_TOKEN: '${secret:API_TOKEN}', REGION: '${secret:REGION}' },
    });
    should(copied.placeholders).deepEqual(['API_TOKEN', 'REGION']);
    should(JSON.stringify(copied)).not.match(new RegExp(FAKE_VALUE, 'u'));
    should(copied.origin).deepEqual({
      kind: 'account',
      owner: 'claude-work',
      harness: 'claude',
      scope: 'user',
      id: stdioServer().id,
    });
  });

  it('should name a project as the owner of a project server, and the machine of one nobody runs', () => {
    const project = copiableMcp(stdioServer({ project: { root: '/work/other' }, scope: 'project' }));
    const nobody = copiableMcp(stdioServer({ runtimes: [] }));

    should(project.ok && project.origin).containEql({ kind: 'project', owner: '/work/other' });
    should(nobody.ok && nobody.origin.owner).equal('this machine');
  });

  it('should copy a component, whose environment held references rather than values', () => {
    const copied = copiableMcp(
      stdioServer({
        scope: 'component',
        declaration: null,
        component: { command: 'docs', args: [], env: { DOCS_KEY: '${secret:DOCS_KEY}' } },
      }),
    );

    should(copied.ok && copied.placeholders).deepEqual(['DOCS_KEY']);
  });

  it('should copy a component URL server without an environment', () => {
    const copied = copiableMcp(
      stdioServer({ scope: 'component', declaration: null, component: { url: 'https://mcp.example.com/mcp' } }),
    );

    should(copied.ok && copied.placeholders).deepEqual([]);
    should(copied.ok && copied.setup).deepEqual({ transport: 'url', url: 'https://mcp.example.com/mcp' });
  });

  it('should leave out an address’s user name, password, key-like parameters and key-like fragment, and say so', () => {
    const copied = copiableMcp(
      http('https://user:pw@mcp.example.com/mcp?api_key=zzz&access_token=abc&keep=1&one=2#sk-live-fragment-thing'),
    );

    should(copied.ok).be.true();
    if (!copied.ok) return;
    should(copied.setup).deepEqual({ transport: 'url', url: 'https://mcp.example.com/mcp?keep=1&one=2' });
    should(copied.skipped.map(problem => problem.subject)).deepEqual(['url', 'url', 'url']);
    should(JSON.stringify(copied)).not.match(/user:pw|=zzz|=abc|sk-live/u);
  });

  it('should say one query parameter in the singular, and drop a fragment only when it looks like a key', () => {
    const one = copiableMcp(http('https://mcp.example.com/mcp?api_key=zzz#plain'));
    const noQuery = copiableMcp(http('https://mcp.example.com/mcp#plain'));

    should(one.ok && one.setup).deepEqual({ transport: 'url', url: 'https://mcp.example.com/mcp#plain' });
    should(one.ok && one.skipped[0]?.reason).match(/1 query parameter that look like keys was left/u);
    should(noQuery.ok && noQuery.skipped).deepEqual([]);
  });

  it('should keep the declaration’s own problems, such as headers that were not copied', () => {
    const copied = copiableMcp(
      stdioServer({
        declaration: {
          name: 'search',
          transport: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: 'Bearer nothing' },
        },
      }),
    );

    should(copied.ok && copied.skipped.length).be.above(0);
    should(JSON.stringify(copied)).not.match(/Bearer nothing/u);
  });

  it('should leave a variable out when its name cannot be a secret placeholder, without showing a hostile name', () => {
    const copied = copiableMcp(stdioWith({ lower_case: 'a', _LEADING: 'b', 'EVIL‮ NAME': 'c', FINE: 'd' }));

    should(copied.ok && copied.placeholders).deepEqual(['FINE']);
    if (!copied.ok) return;
    should(copied.skipped.map(problem => problem.subject).toSorted()).deepEqual([
      'environment _LEADING',
      'environment a variable with an unusual name',
      'environment lower_case',
    ]);
  });

  it('should keep to the contract’s most variables and say what it left out', () => {
    const env = Object.fromEntries(
      Array.from({ length: 66 }, (_, index) => [`VAR_${String(index).padStart(2, '0')}`, 'v']),
    );

    const copied = copiableMcp(stdioWith(env));

    should(copied.ok && copied.placeholders.length).equal(64);
    should(copied.ok && copied.skipped.length).equal(2);
  });

  it('should refuse a server the catalog conversion refuses, giving its reason', () => {
    const results = [
      copiableMcp(stdioServer({ name: 'bad one' })),
      copiableMcp(stdioServer({ declaration: null })),
      copiableMcp(http('not a url')),
    ];

    for (const result of results) {
      should(result.ok).be.false();
      should(!result.ok && result.reason.length).be.above(0);
    }
  });
});
