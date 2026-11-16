/**
 * CFG-LEAK (ii) batch 2: every place a value of ANY shape is shown beside its name goes through the one rule
 * (`valueWithheld`, `valueSaid`): a conflict sentence, a non-scalar settings value, a fixed-layer overridden row, a
 * Resolved MCP url, and a command whose last word is a flag (`srv --token` beside its arguments). Fake values only.
 *
 * Per-test limit (testing standard): each test builds a small model and reads it once, about 20 ms; the default 5 s
 * limit is a margin, and the 256 KiB test names its own.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { NOT_SHOWN_VALUE, valueSaid, valueWithheld } from '../../../daemon/lib/service/command-line.ts';
import { resolveProfile } from '../../../daemon/lib/account/layering.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import {
  type CatalogFacts,
  componentCatalog,
  profileCatalog,
  runtimeCatalog,
} from '../../../daemon/lib/service/catalog.ts';
import { resolvedEntries } from '../../../daemon/lib/service/resolved-view.ts';
import { ratioOf } from '@ferretry/std/testing/linear-time';

const V = 'Zk3pQ9vXw2LmN7rT';
const W = 'Hy8cBt4Fg6SdJ1uE';
const GSK = 'gsk_AbCdEfGhIjKlMnOpQrSt12';
const FACTS: CatalogFacts = {
  format: 'present',
  machineName: 'studio',
  tools: { claude: '/usr/bin/claude', codex: undefined },
  runningSessions: 0,
  userHome: '/home/person',
  acceptsAutoPermissionMode: true,
};
const model = (components: Record<string, unknown>, profiles: Record<string, unknown> = {}, extra = {}) =>
  parseAccountModel({ version: 1, components, profiles, ...extra });

/** Every sentence the profile list says about conflicts, for a stack of two settings layers. */
function sentences(
  one: Record<string, unknown>,
  two: Record<string, unknown>,
  env: [Record<string, string>, Record<string, string>] = [{}, {}],
): string {
  const parsed = model(
    {
      settings: {
        one: { harness: 'claude', file: 'one.json', env: env[0] },
        two: { harness: 'claude', file: 'two.json', env: env[1] },
      },
    },
    { p: { layers: ['settings/one', 'settings/two'] } },
  );
  const found = profileCatalog(parsed, { ...FACTS, settingsBodies: { one, two } });
  return found.profiles
    .flatMap(profile => profile.harnesses.flatMap(stack => stack.conflicts.map(c => c.sentence)))
    .join('\n');
}

describe('(A) a conflict sentence does not say a value the write rule refuses', () => {
  const cases: readonly [
    string,
    Record<string, unknown>,
    Record<string, unknown>,
    [Record<string, string>, Record<string, string>],
  ][] = [
    ['env API_KEY in two layers', {}, {}, [{ API_KEY: V }, { API_KEY: W }]],
    ['env PATH with a flag secret', {}, {}, [{ PATH: `--token ${V}` }, { PATH: '/usr/bin' }]],
    ['env PATH with a flag secret as the winner', {}, {}, [{ PATH: '/usr/bin' }, { PATH: `--token ${V}` }]],
    ['settings apiToken', { apiToken: V }, { apiToken: W }, [{}, {}]],
    [
      'settings defaultMode with a flag secret',
      { permissions: { defaultMode: `--token ${V}` } },
      { permissions: { defaultMode: 'plan' } },
      [{}, {}],
    ],
    ['settings value with a token shape', { label: GSK }, { label: 'plain' }, [{}, {}]],
  ];
  for (const [name, one, two, env] of cases) {
    it(`should leave the value out of the sentence: ${name}`, () => {
      // Act
      const said = sentences(one, two, env);

      // Assert
      for (const raw of [V, W, GSK]) should(said).not.containEql(raw);
      should(said).containEql(NOT_SHOWN_VALUE);
      should(said).containEql('overrides');
    });
  }

  it('should say a plain value as it is', () => {
    // Act
    const said = sentences({ permissions: { defaultMode: 'plan' } }, { permissions: { defaultMode: 'acceptEdits' } });

    // Assert
    should(said).containEql('acceptEdits (from two) overrides plan (from one)');
  });

  it('should leave a model id the write rule refuses out of the sentence', () => {
    // Arrange
    const parsed = model(
      {
        modelSets: {
          one: { models: ['claude-opus-5-5', `claude-${GSK}`], default: `claude-${GSK}` },
          two: { models: ['claude-haiku-5-5'], default: 'claude-haiku-5-5' },
        },
      },
      { p: { layers: ['modelSets/one', 'modelSets/two'] } },
    );

    // Act
    const found = profileCatalog(parsed, FACTS);
    const said = found.profiles
      .flatMap(profile => profile.harnesses.flatMap(stack => stack.conflicts.map(c => c.sentence)))
      .join('\n');

    // Assert
    should(said).not.containEql(GSK);
    should(said).containEql(NOT_SHOWN_VALUE);
  });
});

describe('(B) a non-scalar settings value is judged as the parsed value', () => {
  const bodies: readonly [string, Record<string, unknown>][] = [
    ['a list holding a flag and its value', { x: ['--token', V] }],
    ['a list holding a flag=value', { args: [`--api-key=${V}`] }],
    ['a list of tables holding a token key', { servers: [{ token: V }] }],
    ['a nested list', { a: { b: ['--password', V] } }],
  ];
  for (const [name, body] of bodies) {
    it(`should hide it in the detail entries and in the Resolved rows: ${name}`, () => {
      // Arrange
      const parsed = model(
        { settings: { base: { harness: 'claude', file: 'base.json' } } },
        { p: { layers: ['settings/base'] } },
      );

      // Act
      const detail = componentCatalog(parsed, { ...FACTS, settingsBodies: { base: body } })
        .kinds.flatMap(group => group.components)
        .find(component => component.reference === 'settings/base')?.content;
      const resolved = resolveProfile({
        model: parsed,
        profile: 'p',
        harness: 'claude',
        settingsBodies: { base: body },
      });
      if (!resolved.ok) throw new Error('expected a resolution');

      // Assert
      should(JSON.stringify(detail)).not.containEql(V);
      should(JSON.stringify(resolvedEntries(resolved.resolved))).not.containEql(V);
    });
  }

  it('should show a list that holds no secret, and a plain nested table', () => {
    // Act + Assert
    should(valueSaid('allow', ['Bash(ls)', 'Read'])).equal('["Bash(ls)","Read"]');
    should(valueSaid('servers', [{ name: 'docs', url: 'https://example.com/mcp' }])).equal(
      '[{"name":"docs","url":"https://example.com/mcp"}]',
    );
    should(valueWithheld('x', ['--flag', 'plain'])).be.false();
  });
});

describe('(C) a fixed-layer overridden setting row does not show a value the write rule refuses', () => {
  const row = (body: Record<string, unknown>) => {
    const parsed = parseAccountModel({
      version: 1,
      credentials: { 'claude-a': { harness: 'claude', store: 'ferretry' } },
      components: { settings: { s: { harness: 'claude', file: 'components/settings/s.json' } } },
      profiles: { tuned: { layers: ['settings/s'] } },
      runtimes: { 'claude-default': { credential: 'claude-a', profile: 'tuned', agent: true } },
    });
    return (
      runtimeCatalog(parsed, { ...FACTS, settingsBodies: { s: body } }).runtimes.find(r => r.name === 'claude-default')
        ?.fixedLayer?.overridden ?? []
    );
  };
  for (const value of [`--token ${V}`, GSK, `--api-key=${V}`, `https://u:${V}@h/p`]) {
    it(`should not show ${value.slice(0, 12)}… as the row's value`, () => {
      // Act
      const rows = row({ permissions: { defaultMode: value } });

      // Assert
      should(JSON.stringify(rows)).not.containEql(V);
      should(JSON.stringify(rows)).not.containEql(GSK);
      should(rows.some(entry => entry.value === NOT_SHOWN_VALUE)).be.true();
    });
  }
  it('should show a plain overridden value', () => {
    should(row({ permissions: { defaultMode: 'plan' } }).some(entry => entry.value === 'plan')).be.true();
  });
});

describe('(D) a Resolved MCP url is netted as the detail nets its url', () => {
  const line = (url: string) => {
    const parsed = model({ mcp: { srv: { url } } }, { p: { layers: ['mcp/srv'] } });
    const result = resolveProfile({ model: parsed, profile: 'p', harness: 'claude', settingsBodies: {} });
    if (!result.ok) throw new Error('expected a resolution');
    return resolvedEntries(result.resolved).find(entry => entry.field === 'mcp')?.value ?? '';
  };
  for (const url of [`https://h/mcp --token ${V}`, `https://h/${GSK}`, `https://h/mcp --api-key=${V}`]) {
    it(`should not show the path of ${url.slice(0, 22)}…`, () => {
      should(line(url)).not.containEql(V);
      should(line(url)).not.containEql(GSK);
    });
  }
  it('should show a bare url, and drop a query as before', () => {
    should(line('https://example.com/mcp')).equal('https://example.com/mcp');
    should(line('https://example.com/mcp?page=2')).equal('https://example.com/mcp');
    should(line(`https://example.com/mcp?token=${V}`)).equal('https://example.com/mcp');
  });
});

describe('(E) a command whose last word is a flag pairs with the first argument', () => {
  const view = (command: string, args: readonly string[]) => {
    const parsed = model({ mcp: { srv: { command, args: [...args] } } }, { p: { layers: ['mcp/srv'] } });
    const result = resolveProfile({ model: parsed, profile: 'p', harness: 'claude', settingsBodies: {} });
    if (!result.ok) throw new Error('expected a resolution');
    const resolvedLine = resolvedEntries(result.resolved).find(entry => entry.field === 'mcp')?.value ?? '';
    const detail = componentCatalog(parsed, FACTS)
      .kinds.flatMap(group => group.components)
      .find(component => component.reference === 'mcp/srv')?.detail;
    return { resolvedLine, detail: JSON.stringify(detail) };
  };
  for (const [command, args] of [
    ['srv --token', [V]],
    ['srv --api-key', [V]],
    ['npx -y srv --password', [W]],
    ['srv --token', [GSK]],
  ] as const) {
    it(`should not show the pair ${command} + ${args[0].slice(0, 6)}…`, () => {
      const shown = view(command, args);
      for (const raw of [V, W, GSK]) {
        should(shown.resolvedLine).not.containEql(raw);
        should(shown.detail).not.containEql(raw);
      }
    });
  }
  it('should show a plain command as it is', () => {
    const shown = view('npx -y @scope/pkg', ['--flag']);
    should(shown.resolvedLine).equal('npx -y @scope/pkg --flag');
  });
});

describe('controls: what the write rule accepts stays shown', () => {
  it('should show these values as written', () => {
    for (const [key, value] of [
      ['url', 'https://example.com/mcp'],
      ['command', 'npx -y @scope/pkg'],
      ['command', '/usr/bin/node'],
      ['PATH', '/usr/bin'],
      ['NODE_OPTIONS', '--max-old-space-size=4096'],
      ['url', 'https://example.com/docs?page=2'],
      ['model', 'claude-opus-5-5'],
      ['GREETING', 'hello there'],
    ] as const) {
      should(valueWithheld(key, value)).be.false();
      should(valueSaid(key, value)).equal(value);
    }
  });
});

describe('(G) the Resolved view judges a value under the name the document holds it by, not the quoted display key', () => {
  const rows = (body: Record<string, unknown>) => {
    const parsed = model(
      { settings: { base: { harness: 'claude', file: 'base.json' } } },
      { p: { layers: ['settings/base'] } },
    );
    const result = resolveProfile({ model: parsed, profile: 'p', harness: 'claude', settingsBodies: { base: body } });
    if (!result.ok) throw new Error('expected a resolution');
    return JSON.stringify(resolvedEntries(result.resolved));
  };
  for (const body of [
    { x: { 'db.authtoken': V } },
    { x: { 'my.privatekey': W } },
    { 'a b': { 'client secret': V } },
    { y: { 'api.key': W } },
  ]) {
    it(`should hide the value of ${JSON.stringify(body).slice(0, 30)}`, () => {
      should(rows(body)).not.containEql(V);
      should(rows(body)).not.containEql(W);
    });
  }
  it('should hide a beaten value under such a name too', () => {
    // Arrange
    const parsed = model(
      { settings: { one: { harness: 'claude', file: 'one.json' }, two: { harness: 'claude', file: 'two.json' } } },
      { p: { layers: ['settings/one', 'settings/two'] } },
    );

    // Act
    const result = resolveProfile({
      model: parsed,
      profile: 'p',
      harness: 'claude',
      settingsBodies: { one: { x: { 'db.authtoken': V } }, two: { x: { 'db.authtoken': W } } },
    });
    if (!result.ok) throw new Error('expected a resolution');

    // Assert
    const text = JSON.stringify(resolvedEntries(result.resolved));
    should(text).not.containEql(V);
    should(text).not.containEql(W);
  });
});

describe('(F) a word the raw-secret rule refuses withholds its list in every view', () => {
  const GHP = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
  for (const args of [[GSK], ['--config=/etc/' + GHP], ['--x', GSK], [`https://h.example.com/${GHP}`]]) {
    it(`should withhold ${JSON.stringify(args).slice(0, 30)} in the detail and the Resolved line`, () => {
      // Arrange
      const parsed = model({ mcp: { srv: { command: 'srv', args } } }, { p: { layers: ['mcp/srv'] } });

      // Act
      const detail = JSON.stringify(
        componentCatalog(parsed, FACTS)
          .kinds.flatMap(group => group.components)
          .find(component => component.reference === 'mcp/srv')?.detail,
      );
      const resolved = resolveProfile({ model: parsed, profile: 'p', harness: 'claude', settingsBodies: {} });
      if (!resolved.ok) throw new Error('expected a resolution');

      // Assert
      for (const raw of [GSK, GHP]) {
        should(detail).not.containEql(raw);
        should(JSON.stringify(resolvedEntries(resolved.resolved))).not.containEql(raw);
      }
    });
  }
  it('should show words the raw-secret rule accepts', () => {
    const parsed = model(
      { mcp: { srv: { command: 'npx', args: ['-y', '@scope/pkg', '--config=/etc/app.json'] } } },
      { p: { layers: ['mcp/srv'] } },
    );
    const detail = componentCatalog(parsed, FACTS)
      .kinds.flatMap(group => group.components)
      .find(component => component.reference === 'mcp/srv')?.detail;
    should(detail?.kind === 'mcp' ? detail.args : undefined).eql(['-y', '@scope/pkg', '--config=/etc/app.json']);
  });
});

describe('the batch 2 nets stay linear to 256 KiB', () => {
  const shapes: Readonly<Record<string, (size: number) => () => void>> = {
    'one long settings value': size => () => valueWithheld('x', 'ab1X'.repeat(size / 4)),
    'a long list of settings words': size => () =>
      valueWithheld(
        'x',
        Array.from({ length: size / 8 }, () => 'ab1X-yz9'),
      ),
    'a long list of arguments': size => () => {
      const parsed = model(
        { mcp: { srv: { command: 'srv', args: Array.from({ length: size / 8 }, () => 'ab1X-yz9') } } },
        { p: { layers: ['mcp/srv'] } },
      );
      const resolved = resolveProfile({ model: parsed, profile: 'p', harness: 'claude', settingsBodies: {} });
      if (resolved.ok) resolvedEntries(resolved.resolved);
    },
    'a long url path': size => () => {
      const parsed = model(
        { mcp: { srv: { url: `https://h.example/${'a1B2/'.repeat(size / 5)}` } } },
        { p: { layers: ['mcp/srv'] } },
      );
      const resolved = resolveProfile({ model: parsed, profile: 'p', harness: 'claude', settingsBodies: {} });
      if (resolved.ok) resolvedEntries(resolved.resolved);
    },
  };
  for (const [name, make] of Object.entries(shapes)) {
    it(`should grow under 3x from 128 to 256 KiB: ${name}`, () => {
      const ratio = ratioOf(make(256 * 1024), make(128 * 1024));
      should(ratio).be.below(3);
    }, 60_000);
  }
});

describe('controls in the views: nothing the write rule accepts is withheld by the batch 2 nets', () => {
  it('should show these as written in the Resolved view, the detail and a conflict sentence', () => {
    // Arrange
    const parsed = model(
      {
        mcp: {
          srv: {
            command: '/usr/bin/node',
            args: ['-y', '@scope/pkg'],
            env: { NODE_OPTIONS: '--max-old-space-size=4096' },
          },
        },
        settings: {
          base: { harness: 'claude', file: 'base.json', env: { PATH: '/usr/bin', GREETING: 'hello there' } },
        },
        modelSets: { m: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' } },
      },
      { p: { layers: ['mcp/srv', 'settings/base', 'modelSets/m'] } },
    );

    // Act
    const resolved = resolveProfile({ model: parsed, profile: 'p', harness: 'claude', settingsBodies: { base: {} } });
    if (!resolved.ok) throw new Error('expected a resolution');
    const entries = resolvedEntries(resolved.resolved);
    const detail = JSON.stringify(componentCatalog(parsed, FACTS).kinds);

    // Assert
    should(entries.find(entry => entry.field === 'mcp')?.value).equal('/usr/bin/node -y @scope/pkg');
    should(entries.find(entry => entry.key.endsWith('PATH'))?.value).equal('/usr/bin');
    should(entries.find(entry => entry.key.endsWith('GREETING'))?.value).equal('hello there');
    should(entries.find(entry => entry.field === 'model')?.value).equal('claude-opus-5-5');
    should(detail).containEql('--max-old-space-size=4096');
    should(entries.some(entry => entry.hidden === true)).be.false();
  });
});
