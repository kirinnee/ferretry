import { describe, it } from 'bun:test';
import should from 'should';
import { copiableMcp, type LocalMcpInventoryServer } from '../../../src/lib/local-mcp-installs/source.ts';
import { FAKE_VALUE, stdioServer } from './support.ts';

/** A whole secret reference, written so it is not a template placeholder. */
const REF = ['$', '{secret:TOKEN}'].join('');

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

  it('should read a plus as a space, so a credential written with plus signs alone is still left out', () => {
    const copied = copiableMcp(
      http(`https://mcp.example.com/mcp?x=Bearer+${FAKE_VALUE}&keep=hello+world&other=a+b+c#frag`),
    );

    should(copied.ok && copied.setup).deepEqual({
      transport: 'url',
      url: 'https://mcp.example.com/mcp?keep=hello+world&other=a+b+c#frag',
    });
    should(JSON.stringify(copied)).not.match(new RegExp(`Bearer|${FAKE_VALUE}`, 'u'));
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

  it('should refuse a credential in either representation a row carries, whichever one is copied', () => {
    const leaking = 'https://dummy:hunter2dummy@mcp.example.com';
    const clean = { command: 'node', args: [] as string[], env: {} };
    const rows = [
      // The component is copied, and holds the address; the declaration is empty.
      stdioServer({
        scope: 'component',
        declaration: { name: 'search', transport: 'stdio', command: 'node', args: [], env: {} },
        component: { ...clean, args: [leaking] },
      }),
      // The declaration is copied, and holds the address; the component is clean.
      stdioServer({
        declaration: { name: 'search', transport: 'stdio', command: 'node', args: [leaking], env: {} },
        component: clean,
      }),
    ];
    for (const row of rows) {
      const result = copiableMcp(row);
      should(result.ok).be.false();
      if (result.ok) return;
      should(result.reason).startWith('Its argument 1');
      should(result.reason).not.match(/hunter2dummy/u);
    }
  });

  it('should still copy a row whose two representations are both clean, and say too long of either', () => {
    const both = stdioServer({
      scope: 'component',
      declaration: { name: 'search', transport: 'stdio', command: 'node', args: ['old.js'], env: {} },
      component: { command: 'node', args: ['new.js'], env: {} },
    });
    const copied = copiableMcp(both);
    should(copied.ok && copied.setup).containEql({ args: ['new.js'] });
    const long = stdioServer({
      scope: 'component',
      declaration: { name: 'search', transport: 'stdio', command: 'node', args: ['x'.repeat(100_000)], env: {} },
      component: { command: 'node', args: [], env: {} },
    });
    should(copiableMcp(long).ok).be.false();
  });

  it('should refuse a short authorization value in a JSON header argument, and not read a reference as one', () => {
    for (const header of [
      '{"Authorization":"Basic Zm9vOmJhcg=="}',
      '{"Authorization": "Bearer short"}',
      "{'Authorization':'Basic Zm9vOmJhcg=='}",
      '{\\"Authorization\\":\\"Basic Zm9vOmJhcg==\\"}',
    ]) {
      for (const result of [
        refused('npx', ['mcp-remote', '--headers', header]),
        refused('npx', ['--headers', header], true),
      ]) {
        should(result.ok).be.false();
        if (result.ok) return;
        should(result.reason).not.match(/Zm9vOmJhcg|short/u);
      }
    }
    for (const header of [`{"Authorization":"Bearer ${REF}"}`, `{"Authorization":"${REF}"}`]) {
      // The catalog contract refuses a placeholder in an argument on its own; what is checked is that it is not read as a credential.
      const result = refused('npx', ['--headers', header]);
      should(!result.ok && result.reason.startsWith('Its argument')).be.false();
    }
  });

  const OPAQUE = 'dummy0123456789abcdefghij';
  const encoded: [string, string, string[], string][] = [
    [
      'an encoded key name in an address argument',
      'node',
      ['s.js', `https://mcp.example.com/?api%5Fkey=${OPAQUE}`],
      'Its argument 2',
    ],
    [
      'a plus-escaped credential in an address argument',
      'node',
      [`--url=https://mcp.example.com/?x=Bearer+${OPAQUE}`],
      'Its argument 1',
    ],
    ['a malformed escape in an address argument', 'node', ['https://mcp.example.com/?a=%ZZ'], 'Its argument 1'],
    [
      'a key in the fragment of an address argument',
      'node',
      [`x`, `https://mcp.example.com/#sk-live-${OPAQUE}`],
      'Its argument 2',
    ],
    [
      'a password that begins with a URL escape',
      'node',
      ['s.js', `https://u:%64${OPAQUE}@mcp.example.com`],
      'Its argument 2',
    ],
    ['a curl login whose password begins with a percent sign', 'curl', ['--user', `u:%64${OPAQUE}`], 'Its argument 1'],
    ['a curl login with a percent sign that closes no name', 'curl', ['-u', `u:%${OPAQUE}`], 'Its argument 1'],
    [
      'a password that looks like a reference but is too long to be one',
      'curl',
      [`--user=u:%${'A'.repeat(200)}%`],
      'Its argument 1',
    ],
  ];
  for (const [title, command, args, where] of encoded) {
    it(`should refuse ${title}, naming the place and not the value`, () => {
      for (const result of [refused(command, args), refused(command, args, true)]) {
        should(result.ok).be.false();
        if (result.ok) return;
        should(result.reason).startWith(where);
        should(result.reason).not.match(/dummy0123|api%5Fkey|Bearer/u);
      }
    });
  }

  it('should copy addresses in arguments that hold no key, and a whole %NAME% reference as a password', () => {
    for (const args of [
      ['--url=https://mcp.example.com/mcp?q=hello+world&page=2#top', 'http://localhost:3000/'],
      ['https://user@mcp.example.com/path'],
      [`https://u:%PASSWORD%@mcp.example.com`],
      ['--user=u:%PASSWORD%'],
    ])
      should(refused('curl', args).ok).be.true();
  });

  it('should refuse a command or arguments larger than a server here holds before reading any of them', () => {
    const tooLong = 'a'.repeat(5_000);
    for (const [command, args] of [
      ['n'.repeat(1_025), []],
      ['node', [tooLong]],
      ['node', Array.from({ length: 65 }, () => 'x')],
    ] as const) {
      const result = refused(command, [...args]);

      should(result.ok).be.false();
      if (!result.ok) should(result.reason).startWith('Its command or an argument is longer');
    }
    should(
      refused(
        'node',
        Array.from({ length: 64 }, () => 'x'),
      ).ok,
    ).be.true();
  });

  it('should copy an Authorization header whose value is a reference, with or without its scheme', () => {
    for (const header of [
      'Authorization: Bearer $TOKEN',
      'Authorization: Basic $CREDENTIALS',
      'authorization=Bearer %TOKEN%',
      'Authorization : <your token>',
      'Authorization: "" $TOKEN',
      'Authorization: Bearer',
      'Authorization: Bearer ""',
      'Authorization: Bearer $TOKEN, Authorization: $OTHER',
    ])
      should(refused('npx', ['mcp-remote', '--header', header]).ok).be.true();
    for (const header of [
      'Authorization: Bearer $TOKEN Authorization: Bearer dummy1',
      'Authorization: Bearer %64dummy1',
      'Authorization: "" dummy1',
      'Authorization: Bearer Basic dummy1',
    ])
      should(refused('npx', ['mcp-remote', '--header', header]).ok).be.false();
  });

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
