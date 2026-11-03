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

  it('should read a query name and value as the server would, so an encoded credential is still left out', () => {
    const copied = copiableMcp(
      http(
        'https://mcp.example.com/mcp?api%5Fkey=zzz&keep=1&x=sk%2Dlive%2Dabcdefghijklmnopqrstuv&dbl%255Ftoken=q&a+pi%5Fkey=1&ok=100%25',
      ),
    );

    should(copied.ok).be.true();
    if (!copied.ok) return;
    should(copied.setup).deepEqual({ transport: 'url', url: 'https://mcp.example.com/mcp?keep=1&ok=100%25' });
    should(copied.skipped.map(problem => problem.reason)).deepEqual([
      '4 query parameters that look like keys were left out of the address, not copied',
    ]);
    should(JSON.stringify(copied)).not.match(/api%5Fkey|sk%2Dlive|zzz|dbl%255F/u);
  });

  it('should read a name encoded as many times as the reader will decode it', () => {
    const copied = copiableMcp(http('https://mcp.example.com/mcp?keep=1&deep%25255Fkey=zzz'));

    should(copied.ok && copied.setup).deepEqual({ transport: 'url', url: 'https://mcp.example.com/mcp?keep=1' });
    should(JSON.stringify(copied)).not.match(/deep|zzz/u);
  });

  it('should leave out a query parameter whose encoding is malformed, and say so', () => {
    const one = copiableMcp(http('https://mcp.example.com/mcp?keep=1&bad%ZZ=zzz'));
    const two = copiableMcp(http('https://mcp.example.com/mcp?a=%E0%A4%A&b=%&keep=1'));

    should(one.ok && one.setup).deepEqual({ transport: 'url', url: 'https://mcp.example.com/mcp?keep=1' });
    should(one.ok && one.skipped.map(problem => problem.reason)).deepEqual([
      '1 query parameter with a malformed percent-encoding was left out of the address, not copied',
    ]);
    should(two.ok && two.setup).deepEqual({ transport: 'url', url: 'https://mcp.example.com/mcp?keep=1' });
    should(two.ok && two.skipped[0]?.reason).match(/^2 query parameters with a malformed percent-encoding were left/u);
  });

  it('should leave out a fragment that is an encoded key or cannot be decoded', () => {
    const encoded = copiableMcp(http('https://mcp.example.com/mcp#access%5Ftoken=sk%2Dlive%2Dabcdefghijklmnopqrstuv'));
    const malformed = copiableMcp(http('https://mcp.example.com/mcp#%ZZ'));
    const plain = copiableMcp(http('https://mcp.example.com/mcp#section%202'));

    should(encoded.ok && encoded.setup).deepEqual({ transport: 'url', url: 'https://mcp.example.com/mcp' });
    should(malformed.ok && malformed.setup).deepEqual({ transport: 'url', url: 'https://mcp.example.com/mcp' });
    should(plain.ok && plain.setup).deepEqual({ transport: 'url', url: 'https://mcp.example.com/mcp#section%202' });
    should(plain.ok && plain.skipped).deepEqual([]);
  });

  it('should keep a value containing an equals sign whole when classifying it', () => {
    const copied = copiableMcp(http('https://mcp.example.com/mcp?next=a=b&token=sk-live-abcdefghijklmnopqrstuv'));

    should(copied.ok && copied.setup).deepEqual({ transport: 'url', url: 'https://mcp.example.com/mcp?next=a=b' });
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

describe('a command whose arguments hold a credential is refused, never copied', () => {
  const refused = (command: string, args: string[], component = false) =>
    copiableMcp(
      component
        ? stdioServer({ scope: 'component', declaration: null, component: { command, args, env: {} } })
        : stdioServer({ declaration: { name: 'search', transport: 'stdio', command, args, env: {} } }),
    );

  const cases: [string, string, string[], string][] = [
    [
      'an address with a password',
      'node',
      ['server.js', 'https://dummy:hunter2dummy@mcp.example.com'],
      'Its argument 2',
    ],
    [
      'curl --user split across arguments',
      'curl',
      ['--user', 'dummy:hunter2dummy', 'https://mcp.example.com'],
      'Its argument 1',
    ],
    ['curl -u split across arguments', 'curl', ['-u', 'dummy:hunter2dummy'], 'Its argument 1'],
    ['curl --user= in one argument', 'curl', ['--user=dummy:hunter2dummy'], 'Its argument 1'],
    ['curl -u with its login attached', 'curl', ['-sS', '-udummy:hunter2dummy'], 'Its argument 2'],
    [
      'an Authorization header argument',
      'npx',
      ['mcp-remote', '--header', 'Authorization: Bearer dummy1'],
      'Its argument 3',
    ],
    ['an Authorization header after --header=', 'npx', ['--header=Authorization:Basic dummy1'], 'Its argument 1'],
    ['a credential in the command itself', 'run --token=sk-live-abcdefghijklmnopqrstuv', [], 'Its command'],
    [
      'a value split by a line break',
      'npx',
      ['x', 'https://dummy:hunter2dummy@mcp.example.com\n/path'],
      'Its argument 2',
    ],
  ];
  for (const [title, command, args, where] of cases) {
    it(`should refuse ${title}, naming the place and not the value`, () => {
      for (const result of [refused(command, args), refused(command, args, true)]) {
        should(result.ok).be.false();
        if (result.ok) return;
        should(result.reason).startWith(where);
        should(result.reason).not.match(/hunter2dummy|dummy1|sk-live|dummy:/u);
      }
    });
  }

  it('should copy ordinary arguments, references to a secret, and an Authorization header with no value', () => {
    for (const args of [
      ['-y', '@modelcontextprotocol/server-filesystem', '/work/app'],
      ['--header', 'Authorization: $TOKEN'],
      ['--header', 'Authorization:'],
      ['--authorization-file', '/etc/mcp/auth'],
      ['curl', '-u', 'dummy', 'https://user@mcp.example.com'],
      ['--user=dummy:$PASS', '-uname', '--user=nocolon', '--user=dummy:'],
    ]) {
      should(refused('npx', args).ok).be.true();
    }
  });

  it('should not look at the arguments of an address', () => {
    should(copiableMcp(http('https://mcp.example.com/mcp')).ok).be.true();
    should(
      copiableMcp(
        stdioServer({ scope: 'component', declaration: null, component: { url: 'https://mcp.example.com/mcp' } }),
      ).ok,
    ).be.true();
  });
});
