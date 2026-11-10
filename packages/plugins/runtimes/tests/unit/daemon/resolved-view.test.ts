import { describe, it } from 'bun:test';
import should from 'should';
import { type ResolvedProfile, type ResolveInput, resolveProfile } from '../../../daemon/lib/account/layering.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { resolvedEntries } from '../../../daemon/lib/service/resolved-view.ts';
import { hidesAtLeast, lineHidesAtLeast, nestedBreach, nestedFamily, nestedLineBreach } from './command-line-family.ts';
import { todayFlag, todayServerLine } from './resolved-view-today.ts';
import { shownWordsR2 } from './command-line-r2.ts';

const HIDDEN = '‹hidden›';
// Obviously fake: it only has to have the shape of a provider token so the secret rules see it.
const FAKE_TOKEN = 'sk-not-a-real-key-0000';

const modelWith = (components: Record<string, unknown>, profiles: Record<string, unknown>) =>
  parseAccountModel({ version: 1, components, profiles });

const resolved = (input: ResolveInput): ResolvedProfile => {
  const result = resolveProfile(input);
  if (!result.ok) throw new Error(`expected a resolution, got ${JSON.stringify(result.failure)}`);
  return result.resolved;
};

/** The one entry of this field and key, or a thrown error naming what was missing. */
const entryOf = (entries: ReturnType<typeof resolvedEntries>, field: string, key: string) => {
  const found = entries.find(entry => entry.field === field && entry.key === key);
  if (found === undefined) throw new Error(`no ${field} entry named ${key}`);
  return found;
};

describe('resolvedEntries', () => {
  it('should say every final value with the profile item it came from, in merge order', () => {
    // Arrange
    const model = modelWith(
      {
        instructions: { guide: { file: 'components/instructions/guide.md' } },
        mcp: { github: { command: 'npx', args: ['-y', 'gh-mcp'] } },
        skills: { tools: { items: ['lint', 'format'] } },
        settings: { base: { harness: 'claude', file: 'base.json', flags: ['--verbose'], env: { LOG_LEVEL: 'info' } } },
        hooks: { fmt: { harness: 'claude', file: 'fmt.json' }, tree: { harness: 'claude', directory: 'hooks-dir' } },
        modelSets: { models: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' } },
      },
      {
        p: {
          layers: [
            'instructions/guide',
            'mcp/github',
            'skills/tools',
            'settings/base',
            'hooks/fmt',
            'hooks/tree',
            'modelSets/models',
          ],
        },
      },
    );

    // Act
    const actual = resolvedEntries(
      resolved({ model, profile: 'p', harness: 'claude', settingsBodies: { base: { theme: 'dark' } } }),
    );

    // Assert
    should(actual.map(entry => [entry.field, entry.key, entry.value, entry.from])).deepEqual([
      ['instructions', 'guide', 'components/instructions/guide.md', 'instructions/guide'],
      ['mcp', 'github', 'npx -y gh-mcp', 'mcp/github'],
      ['skills', 'lint', 'included', 'skills/tools'],
      ['skills', 'format', 'included', 'skills/tools'],
      ['settings', 'theme', 'dark', 'settings/base'],
      ['env', 'env.LOG_LEVEL', 'info', 'settings/base'],
      ['flags', 'flag', '--verbose', 'settings/base'],
      ['hooks', 'fmt', 'fmt.json', 'hooks/fmt'],
      ['hooks', 'tree', 'hooks-dir', 'hooks/tree'],
      ['model', 'model', 'claude-opus-5-5', 'modelSets/models'],
    ]);
    should(actual.every(entry => entry.harness === 'claude-code')).be.true();
    should(actual.every(entry => entry.overridden.length === 0)).be.true();
  });

  it('should list the earlier values a newer layer beat, settings and environment alike', () => {
    // Arrange
    const model = modelWith(
      {
        settings: {
          base: { harness: 'claude', file: 'base.json', env: { LOG_LEVEL: 'info' } },
          over: { harness: 'claude', file: 'over.json', env: { LOG_LEVEL: 'debug' } },
        },
      },
      { p: { layers: ['settings/base', 'settings/over'] } },
    );

    // Act
    const actual = resolvedEntries(
      resolved({
        model,
        profile: 'p',
        harness: 'claude',
        settingsBodies: { base: { theme: 'light' }, over: { theme: 'dark' } },
      }),
    );

    // Assert
    should(entryOf(actual, 'settings', 'theme')).containDeep({
      value: 'dark',
      from: 'settings/over',
      overridden: [{ value: 'light', from: 'settings/base' }],
    });
    should(entryOf(actual, 'env', 'env.LOG_LEVEL')).containDeep({
      value: 'debug',
      from: 'settings/over',
      overridden: [{ value: 'info', from: 'settings/base' }],
    });
  });

  it('should say a model set the newest layer chose and the default it beat', () => {
    // Arrange
    const model = modelWith(
      {
        modelSets: {
          heavy: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' },
          light: { models: ['claude-haiku-5-5', 'claude-opus-5-5'], default: 'claude-haiku-5-5' },
        },
      },
      { p: { layers: ['modelSets/heavy', 'modelSets/light'] } },
    );

    // Act
    const actual = resolvedEntries(resolved({ model, profile: 'p', harness: 'claude' }));

    // Assert
    should(actual).have.length(1);
    should(actual[0]).containDeep({
      field: 'model',
      value: 'claude-haiku-5-5',
      from: 'modelSets/light',
      overridden: [{ value: 'claude-opus-5-5', from: 'modelSets/heavy' }],
    });
  });

  it('should list no model when no model set applies and leave the harness to pick', () => {
    // Arrange
    const model = modelWith(
      { instructions: { guide: { file: 'guide.md' } } },
      { p: { layers: ['instructions/guide'] } },
    );

    // Act
    const actual = resolvedEntries(resolved({ model, profile: 'p', harness: 'codex' }));

    // Assert
    should(actual.map(entry => entry.field)).deepEqual(['instructions']);
    should(actual[0]?.harness).equal('codex');
  });

  it('should hide a credential-looking setting, environment value, flag and argument, along with what it beat', () => {
    // Arrange
    const model = modelWith(
      {
        mcp: { local: { command: 'run-server', args: ['--key', FAKE_TOKEN, '--plain'] } },
        settings: {
          base: {
            harness: 'claude',
            file: 'base.json',
            flags: [FAKE_TOKEN],
            env: { API_TOKEN: 'older-value-123' },
          },
          over: { harness: 'claude', file: 'over.json', env: { API_TOKEN: 'newer-value-456' } },
        },
      },
      { p: { layers: ['mcp/local', 'settings/base', 'settings/over'] } },
    );

    // Act
    const actual = resolvedEntries(
      resolved({
        model,
        profile: 'p',
        harness: 'claude',
        settingsBodies: { base: { auth_token: 'older-setting-123' }, over: { auth_token: 'newer-setting-456' } },
      }),
    );

    // Assert
    should(entryOf(actual, 'mcp', 'local').value).equal(`run-server --key ${HIDDEN} --plain`);
    should(entryOf(actual, 'settings', 'auth_token')).containDeep({
      value: HIDDEN,
      hidden: true,
      overridden: [{ value: HIDDEN, hidden: true }],
    });
    should(entryOf(actual, 'env', 'env.API_TOKEN')).containDeep({
      value: HIDDEN,
      hidden: true,
      overridden: [{ value: HIDDEN, hidden: true }],
    });
    should(entryOf(actual, 'flags', 'flag')).containDeep({ value: HIDDEN, hidden: true });
    should(JSON.stringify(actual))
      .not.containEql('value-123')
      .and.not.containEql('value-456')
      .and.not.containEql(FAKE_TOKEN);
  });

  it('should say a url server by where it is reached, without its user, query or fragment', () => {
    // Arrange
    const model = modelWith(
      { mcp: { remote: { url: 'https://user:pass@mcp.example.test/sse?key=abc#frag' } } },
      { p: { layers: ['mcp/remote'] } },
    );

    // Act
    const actual = resolvedEntries(resolved({ model, profile: 'p', harness: 'claude' }));

    // Assert
    should(entryOf(actual, 'mcp', 'remote').value).equal('https://mcp.example.test/sse');
  });

  it('should hide a server url it cannot parse rather than print it', () => {
    // Arrange — the schema refuses this document, so the catalogue is built past it.
    const model = {
      components: {
        instructions: {},
        mcp: { odd: { url: 'not a url?secret=1' } },
        skills: {},
        settings: {},
        hooks: {},
        modelSets: {},
      },
      profiles: { p: { layers: ['mcp/odd'] } },
    } as unknown as ResolveInput['model'];

    // Act
    const actual = resolvedEntries(resolved({ model, profile: 'p', harness: 'claude' }));

    // Assert
    should(entryOf(actual, 'mcp', 'odd').value).equal(HIDDEN);
  });

  it('should write a command-less server as its arguments alone and skip empty words', () => {
    // Arrange
    const model = {
      components: {
        instructions: {},
        mcp: { bare: { args: ['', 'only'] } },
        skills: {},
        settings: {},
        hooks: {},
        modelSets: {},
      },
      profiles: { p: { layers: ['mcp/bare'] } },
    } as unknown as ResolveInput['model'];

    // Act
    const actual = resolvedEntries(resolved({ model, profile: 'p', harness: 'claude' }));

    // Assert
    should(entryOf(actual, 'mcp', 'bare').value).equal('only');
  });

  it('should write a server with neither command nor arguments as nothing', () => {
    // Arrange
    const model = {
      components: { instructions: {}, mcp: { empty: {} }, skills: {}, settings: {}, hooks: {}, modelSets: {} },
      profiles: { p: { layers: ['mcp/empty'] } },
    } as unknown as ResolveInput['model'];

    // Act
    const actual = resolvedEntries(resolved({ model, profile: 'p', harness: 'claude' }));

    // Assert
    should(entryOf(actual, 'mcp', 'empty').value).equal('');
  });

  it('should write a non-text setting as JSON', () => {
    // Arrange
    const model = modelWith(
      { settings: { base: { harness: 'claude', file: 'base.json' } } },
      { p: { layers: ['settings/base'] } },
    );

    // Act
    const actual = resolvedEntries(
      resolved({ model, profile: 'p', harness: 'claude', settingsBodies: { base: { retries: 3, quiet: true } } }),
    );

    // Assert
    should(entryOf(actual, 'settings', 'retries').value).equal('3');
    should(entryOf(actual, 'settings', 'quiet').value).equal('true');
  });
});

// ── A credential in a command line (ruling #37) ─────────────────────────────────────────────────────
//
// 4.291.5 judged a launch flag and an MCP argument as a whole word under no name, and its token-prefix rule is
// anchored at the start of the word, so `--token=<value>` (and `--token <value>`, `-Hsk-…`, …) was shown in full.
// 5.0 hides the VALUE and keeps the flag. Every value here is an obviously fake one.

// Obviously fake, and no token shape: hidden only beside a name that says it is a secret.
const FAKE_SECRET = 'not-a-real-secret-0000';
// Obviously fake, in the shape of a GitHub token: hidden wherever it stands.
const FAKE_GH = 'ghp_notarealtoken0000';

/** What the Resolved view says for these launch flags, one layer per list, in order. */
function shownFlags(...layers: readonly (readonly string[])[]): { value: string; hidden?: true }[] {
  const names = layers.map((_, index) => `layer${String(index)}`);
  const model = modelWith(
    {
      settings: Object.fromEntries(
        layers.map((flags, index) => [names[index], { harness: 'claude', flags: [...flags] }]),
      ),
    },
    { p: { layers: names.map(name => `settings/${name}`) } },
  );
  return resolvedEntries(resolved({ model, profile: 'p', harness: 'claude' }))
    .filter(entry => entry.field === 'flags')
    .map(entry => (entry.hidden === true ? { value: entry.value, hidden: true } : { value: entry.value }));
}

/** What the Resolved view says for an MCP server started as `run-server <args>`. */
function shownServer(args: readonly string[]): string {
  const model = modelWith(
    { mcp: { local: { command: 'run-server', args: [...args] } } },
    { p: { layers: ['mcp/local'] } },
  );
  return entryOf(resolvedEntries(resolved({ model, profile: 'p', harness: 'claude' })), 'mcp', 'local').value;
}

const hid = (value: string) => ({ value, hidden: true as const });
const as = (value: string) => ({ value });

describe('resolvedEntries — a credential in a command line', () => {
  it('should hide the value of a secret-named flag glued by =, and keep the flag: --token=<value>', () => {
    // Act
    const actual = shownFlags([`--token=${FAKE_SECRET}`, `--api-key=${FAKE_SECRET}`, `--Client-Secret=${FAKE_SECRET}`]);

    // Assert
    should(actual).deepEqual([hid(`--token=${HIDDEN}`), hid(`--api-key=${HIDDEN}`), hid(`--Client-Secret=${HIDDEN}`)]);
  });

  it('should hide the word after a secret-named flag, and keep the flag: --token <value>', () => {
    // Act
    const actual = shownFlags(['--token', FAKE_SECRET, '--verbose']);

    // Assert
    should(actual).deepEqual([as('--token'), hid(HIDDEN), as('--verbose')]);
  });

  it('should hide the word after a secret-named flag a later layer brought: --token, then <value>', () => {
    // Act — the flags of every layer are one command line, oldest first.
    const actual = shownFlags(['--token'], [FAKE_SECRET]);

    // Assert
    should(actual).deepEqual([as('--token'), hid(HIDDEN)]);
  });

  it('should hide the value of a one-dash flag glued by =: -token=<value> and -k=<token>', () => {
    // Act
    const actual = shownFlags([`-token=${FAKE_SECRET}`, `-k=${FAKE_TOKEN}`]);

    // Assert
    should(actual).deepEqual([hid(`-token=${HIDDEN}`), hid(`-k=${HIDDEN}`)]);
  });

  it('should hide a token after = under a harmless flag name: --header=Bearer <token>', () => {
    // Act
    const actual = shownFlags([`--header=Bearer ${FAKE_GH}`, `--model=${FAKE_TOKEN}`, `--header=x-key:${FAKE_GH}`]);

    // Assert
    should(actual).deepEqual([hid(`--header=${HIDDEN}`), hid(`--model=${HIDDEN}`), hid(`--header=${HIDDEN}`)]);
  });

  it('should hide a token stuck to a one-letter flag: -H<token>', () => {
    // Act
    const actual = shownFlags([`-H${FAKE_TOKEN}`, `-k${FAKE_GH}`]);

    // Assert
    should(actual).deepEqual([hid(`-H${HIDDEN}`), hid(`-k${HIDDEN}`)]);
  });

  it('should hide a value written in the same word as its flag after a space: "--token <value>"', () => {
    // Act
    const actual = shownFlags([`--token ${FAKE_SECRET}`, `--header Bearer ${FAKE_GH}`, `-k\t${FAKE_TOKEN}`]);

    // Assert
    should(actual).deepEqual([hid(`--token ${HIDDEN}`), hid(`--header ${HIDDEN}`), hid(`-k\t${HIDDEN}`)]);
  });

  it(`should hide a quoted value and a quoted token: --token="<value>", --password '<value>' and "<token>"`, () => {
    // Act
    const actual = shownFlags([`--token="${FAKE_SECRET}"`, '--password', `'${FAKE_SECRET}'`, `"${FAKE_TOKEN}"`]);

    // Assert
    should(actual).deepEqual([hid(`--token=${HIDDEN}`), as('--password'), hid(HIDDEN), hid(HIDDEN)]);
  });

  it('should keep a pointer, a value too short to be a secret and a harmless value as written (control)', () => {
    // Arrange
    const flags = [
      '--token=$API_TOKEN',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference is the literal text `${secret:NAME}`
      '--token="${secret:API_TOKEN}"',
      "--token='$API_TOKEN'",
      '--token',
      '"$API_TOKEN"',
      '--auth=1',
      '--model=claude-opus-5-5',
      '--name',
      FAKE_SECRET,
      `--name=${FAKE_SECRET}`,
      '-v',
      '-Hverbose',
      '--add-dir=/home/person/task-runner-default',
    ];

    // Act
    const actual = shownFlags(flags);

    // Assert
    should(actual).deepEqual(flags.map(as));
  });

  it('should judge a word by the flag right before it only, never by a word that is no flag (control)', () => {
    // Arrange — a flag after a secret-named flag is a flag, and a word after a plain word is judged on its own.
    const flags = ['--token', '--verbose', 'token', FAKE_SECRET, '---token', FAKE_SECRET, '--password'];

    // Act
    const actual = shownFlags(flags);

    // Assert
    should(actual).deepEqual(flags.map(as));
  });

  it("should hide the same shapes in an MCP server's arguments, keeping every flag", () => {
    // Act
    const actual = shownServer([
      `--token=${FAKE_SECRET}`,
      '--api-key',
      FAKE_SECRET,
      `-H${FAKE_TOKEN}`,
      `--header=Bearer ${FAKE_GH}`,
      `"${FAKE_TOKEN}"`,
      '--plain',
      FAKE_SECRET,
    ]);

    // Assert
    should(actual).equal(
      `run-server --token=${HIDDEN} --api-key ${HIDDEN} -H${HIDDEN} --header=${HIDDEN} ${HIDDEN} --plain ${FAKE_SECRET}`,
    );
  });
});

// ── The family, generated ────────────────────────────────────────────────────────────────────────────
//
// Every flag spelling (long and short, secret-named and harmless-named) × separator ('=', the next word, a space in
// the same word, none for a one-letter flag) × case × quoting (none, single, double) × value × the value at the end of
// the command line or before another flag. Each secret value must be gone from what is shown, the flag must keep its
// spelling, and every control (a pointer, a value too short to be a secret, a plain value under a harmless name) and
// every word around the shape must be as written.

const SECRET_NAMED = ['--token', '--api-key', '--auth-token', '--password', '--client-secret', '-token', '-password'];
const HARMLESS_NAMED = ['--header', '--model', '--name'];
const ONE_LETTER = ['-k', '-H', '-p'];
type Separator = '=' | 'next word' | 'space' | 'none';
const SPELLING_CASES: readonly ((flag: string) => string)[] = [
  flag => flag.toLowerCase(),
  flag => flag.toUpperCase(),
  flag => flag.replace(/[a-z]+/giu, word => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`),
];
const QUOTES = ['', "'", '"'];
/** `body` is what must not be shown; `secret` says when the value is one. */
const VALUES: readonly { value: string; secret: 'under a secret name' | 'always' | 'never'; body: string }[] = [
  { value: FAKE_SECRET, secret: 'under a secret name', body: FAKE_SECRET },
  { value: FAKE_TOKEN, secret: 'always', body: 'not-a-real-key-0000' },
  { value: `Bearer ${FAKE_GH}`, secret: 'always', body: 'notarealtoken0000' },
  { value: '$API_TOKEN', secret: 'never', body: '' },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference is the literal text `${secret:NAME}`
  { value: '${secret:API_TOKEN}', secret: 'never', body: '' },
  { value: 'short', secret: 'never', body: '' },
];
const BEFORE = '--print';
const AFTER = '--verbose';

interface FamilyCase {
  readonly label: string;
  readonly words: readonly string[];
  /** The index of the word that holds the flag, and of the word that holds the value. */
  readonly flagAt: number;
  readonly valueAt: number;
  readonly flag: string;
  readonly secret: boolean;
  readonly body: string;
}

function familyCases(): readonly FamilyCase[] {
  const cases = new Map<string, FamilyCase>();
  const spellings = [
    ...SECRET_NAMED.map(flag => ({ flag, named: true, separators: ['=', 'next word', 'space'] as Separator[] })),
    ...HARMLESS_NAMED.map(flag => ({ flag, named: false, separators: ['=', 'next word', 'space'] as Separator[] })),
    ...ONE_LETTER.map(flag => ({ flag, named: false, separators: ['=', 'next word', 'space', 'none'] as Separator[] })),
  ];
  for (const spelling of spellings) {
    for (const spell of SPELLING_CASES) {
      const flag = spell(spelling.flag);
      for (const separator of spelling.separators) {
        for (const quote of QUOTES) {
          for (const { value, secret, body } of VALUES) {
            for (const last of [true, false]) {
              const quoted = `${quote}${value}${quote}`;
              const shape =
                separator === 'next word'
                  ? [flag, quoted]
                  : [`${flag}${{ '=': '=', space: ' ', none: '' }[separator]}${quoted}`];
              const words = [BEFORE, ...shape, ...(last ? [] : [AFTER])];
              const label = JSON.stringify(words);
              cases.set(label, {
                label,
                words,
                flagAt: 1,
                valueAt: shape.length,
                flag,
                secret: secret === 'always' || (secret === 'under a secret name' && spelling.named),
                body,
              });
            }
          }
        }
      }
    }
  }
  return [...cases.values()];
}

/** What is wrong with what was shown for one case, or nothing. */
function familyBreach(family: FamilyCase, shown: readonly { value: string; hidden?: true }[]): string | undefined {
  const values = shown.map(word => word.value);
  if (values.length !== family.words.length) return `${family.label}: ${String(values.length)} words shown`;
  for (const [index, word] of family.words.entries()) {
    const touched = index === family.flagAt || index === family.valueAt;
    if (!touched || !family.secret) {
      if (values[index] !== word || shown[index]?.hidden !== undefined) return `${family.label}: changed ${word}`;
    }
  }
  if (!family.secret) return undefined;
  if (values.some(value => value.includes(family.body))) return `${family.label}: shows ${family.body}`;
  if (!(values[family.flagAt] ?? '').startsWith(family.flag)) return `${family.label}: lost the flag ${family.flag}`;
  if (shown[family.valueAt]?.hidden !== true) return `${family.label}: not marked hidden`;
  return undefined;
}

describe('resolvedEntries — every command-line shape of a flag and its value (generated)', () => {
  const cases = familyCases();

  it(`should hide every secret value of every launch-flag shape (${String(cases.length)} shapes), keep the flag, and touch no control`, () => {
    // Act
    const breaches = cases.flatMap(family => familyBreach(family, shownFlags(family.words)) ?? []);

    // Assert
    should(cases.filter(family => family.secret).length).be.above(1000);
    should(cases.filter(family => !family.secret).length).be.above(1000);
    should(breaches).deepEqual([]);
  });

  it(`should hide every secret value of every MCP-argument shape (${String(cases.length)} shapes), keep the flag, and touch no control`, () => {
    // Act — the line is split back into its words where the shape put no space of its own.
    const breaches = cases.flatMap(family => {
      const line = shownServer(family.words);
      if (!line.startsWith(`run-server ${BEFORE} `)) return [`${family.label}: lost its start`];
      if (family.words.at(-1) === AFTER && !line.endsWith(` ${AFTER}`)) return [`${family.label}: lost ${AFTER}`];
      if (!family.secret) return line === ['run-server', ...family.words].join(' ') ? [] : [`${family.label}: changed`];
      if (line.includes(family.body)) return [`${family.label}: shows ${family.body}`];
      return line.includes(`${BEFORE} ${family.flag}`) && line.includes(HIDDEN)
        ? []
        : [`${family.label}: lost the flag`];
    });

    // Assert
    should(breaches).deepEqual([]);
  });
});

// ── A credential nested inside a value (ruling #40) ──────────────────────────────────────────────────
//
// 4.291.5 and #37 showed a secret-named key inside a value under a harmless flag in full: codex `-c …API_KEY=<v>`,
// `--header=Authorization: Bearer <v>`, `X-Api-Key: <v>`, a URL's user password and `?token=<v>`. 5.0 cuts the value
// and keeps the key, the flag, the user, the host and the other parameters.

describe('resolvedEntries — a credential nested inside a value (ruling #40)', () => {
  it('should hide a secret-named key nested in a value and keep the key: -c …API_KEY=<v>, Authorization: Bearer <v>, X-Api-Key: <v>', () => {
    // Act
    const actual = shownFlags([
      '-c',
      `mcp_servers.x.env.API_KEY=${FAKE_SECRET}`,
      `--header=Authorization: Bearer ${FAKE_SECRET}`,
      `--header=X-Api-Key: ${FAKE_SECRET}`,
      `-HAuthorization: Basic ${FAKE_SECRET}`,
      `--set=a=1,api_key=${FAKE_SECRET},b=2`,
    ]);

    // Assert
    should(actual).deepEqual([
      as('-c'),
      hid(`mcp_servers.x.env.API_KEY=${HIDDEN}`),
      hid(`--header=Authorization: ${HIDDEN}`),
      hid(`--header=X-Api-Key: ${HIDDEN}`),
      hid(`-HAuthorization: ${HIDDEN}`),
      hid(`--set=a=1,api_key=${HIDDEN},b=2`),
    ]);
  });

  it("should hide a URL user's password and a secret-named query parameter, keeping the user, the host and every other parameter", () => {
    // Act
    const actual = shownFlags([
      `--url=postgres://person:${FAKE_SECRET}@db.example.invalid/app`,
      'https://person:pw@h.example.invalid',
      `--endpoint`,
      `https://h.example.invalid/x?token=${FAKE_SECRET}&model=m&access_token=${FAKE_SECRET}`,
    ]);

    // Assert
    should(actual).deepEqual([
      hid(`--url=postgres://person:${HIDDEN}@db.example.invalid/app`),
      hid(`https://person:${HIDDEN}@h.example.invalid`),
      as('--endpoint'),
      hid(`https://h.example.invalid/x?token=${HIDDEN}&model=m&access_token=${HIDDEN}`),
    ]);
  });

  it('should keep a pointer, a short value, a harmless key and a URL with no password as written (control)', () => {
    // Arrange
    const words = [
      '-c',
      'mcp_servers.x.env.API_KEY=$OPENAI_API_KEY',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference is the literal text `${secret:NAME}`
      '--header=Authorization: Bearer ${secret:MCP_TOKEN}',
      '--set=api_key=short',
      '--header=X-Request-Id: not-a-secret-0000',
      'https://person@h.example.invalid/x?model=m&page=2',
      'postgres://person:$DB_PASSWORD@db.example.invalid',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a pointer whose default is a name, not a key
      '--env=${API_TOKEN:-default-value}',
    ];

    // Act
    const actual = shownFlags(words);

    // Assert
    should(actual).deepEqual(words.map(as));
  });

  it("should hide the same nested shapes in an MCP server's arguments", () => {
    // Act
    const actual = shownServer([
      '--header',
      `Authorization: Bearer ${FAKE_SECRET}`,
      `https://person:${FAKE_SECRET}@h.example.invalid/x?api_key=${FAKE_SECRET}&model=m`,
      '--plain',
    ]);

    // Assert
    should(actual).equal(
      `run-server --header Authorization: ${HIDDEN} https://person:${HIDDEN}@h.example.invalid/x?api_key=${HIDDEN}&model=m --plain`,
    );
  });

  it('should read a run of keys and separators in one pass, not once from every character (linear)', () => {
    // Arrange — a long value of secret-named keys with short values, and a long run with no separator.
    const keys = `--set=${'token=ab,'.repeat(20_000)}`;
    const run = `--set=${'a'.repeat(200_000)}`;
    // Quoted short values (each walked to its closing quote once), and keys in a glued flag's own part.
    const quoted = `--set=${'token="ab",'.repeat(20_000)}`;
    const flagPart = `--hdr,${'token:ab,'.repeat(20_000)} x`;
    const started = performance.now();

    // Act
    const actual = shownFlags([keys, run, quoted, flagPart]);

    // Assert
    should(actual.map(word => word.value)).deepEqual([keys, run, quoted, flagPart]);
    should(performance.now() - started).be.below(2_000);
  });
});

describe('resolvedEntries — every nested credential shape (ruling #40, generated)', () => {
  const cases = nestedFamily();

  it(`should hide every nested secret of every launch-flag shape (${String(cases.length)} shapes), keep the key and flag, at least as much as today, and touch no control`, () => {
    // Act
    const breaches = cases.flatMap(family => {
      const shown = shownFlags(family.words);
      const floor = family.words.flatMap((word, index) =>
        hidesAtLeast(word, todayFlag(word), shown[index] ?? { value: '' }) ? [] : [`${family.label}: under today`],
      );
      const breach = nestedBreach(family, shown);
      return breach === undefined ? floor : [...floor, breach];
    });

    // Assert
    should(cases.filter(family => family.secret).length).be.above(1000);
    should(cases.filter(family => !family.secret).length).be.above(1000);
    should(breaches).deepEqual([]);
  });

  it(`should hide every nested secret of every MCP-argument shape (${String(cases.length)} shapes), at least as much as today, and touch no control`, () => {
    // Act
    const breaches = cases.flatMap(family => {
      const line = shownServer(family.words);
      const today = todayServerLine({ command: 'run-server', args: family.words });
      return [
        ...(lineHidesAtLeast(today, line) ? [] : [`${family.label}: under today`]),
        ...[nestedLineBreach(family, 'run-server', line)].filter(breach => breach !== undefined),
      ];
    });

    // Assert
    should(breaches).deepEqual([]);
  });
});

// ── Review r1 of the #40 rule (F2, F3, and what the broadened generator found in r2) ──────────────────

describe('resolvedEntries — the #40 rule after review r1 (F2, F3)', () => {
  const NESTED = 'nested-fake-value-0000';

  it('should hide at least what #37 hid when a token is stuck to -H before a nested key: -H<token> KEY=v, -H<token>=KEY=v (F2)', () => {
    // Arrange
    const words = [`-H${FAKE_TOKEN} API_KEY=${NESTED}`, `-H${FAKE_TOKEN}=API_KEY=${NESTED}`, `-H${FAKE_TOKEN} model=m`];

    // Act
    const flags = shownFlags(words);
    const line = shownServer(words);

    // Assert
    should(flags).deepEqual([hid(`-H${HIDDEN}`), hid(`-H${HIDDEN}`), hid(`-H${HIDDEN}`)]);
    should(line).equal(`run-server -H${HIDDEN} -H${HIDDEN} -H${HIDDEN}`);
  });

  it("should cut a URL user's password holding a raw @ up to the last @ before the host, keeping the user and host (F3)", () => {
    // Act
    const actual = shownFlags([
      `https://person:p@ss${FAKE_SECRET}@db.example.invalid/x`,
      `--url=postgres://person:a@b@${FAKE_SECRET}@db.example.invalid?token=${FAKE_SECRET}&model=m`,
    ]);

    // Assert
    should(actual).deepEqual([
      hid(`https://person:${HIDDEN}@db.example.invalid/x`),
      hid(`--url=postgres://person:${HIDDEN}@db.example.invalid?token=${HIDDEN}&model=m`),
    ]);
  });

  it('should cut a quoted nested value holding a separator up to its closing quote, keeping what follows (F3)', () => {
    // Act
    const actual = shownFlags([
      `--set=API_KEY="${FAKE_SECRET},more${FAKE_SECRET}",b=2`,
      `--set=api_key='${FAKE_SECRET};${FAKE_SECRET}'&model=m`,
      `--set=API_KEY=a:'${FAKE_SECRET},${FAKE_SECRET}',b=2`,
      `--set=ACCESS_TOKEN=api_key: '${FAKE_SECRET},${FAKE_SECRET}'`,
    ]);

    // Assert
    should(actual).deepEqual([
      hid(`--set=API_KEY=${HIDDEN},b=2`),
      hid(`--set=api_key=${HIDDEN}&model=m`),
      hid(`--set=API_KEY=${HIDDEN},b=2`),
      hid(`--set=ACCESS_TOKEN=${HIDDEN}`),
    ]);
  });

  it("should hide a secret-named key in a glued flag's own part: --hdr,api_key:<v> more, --x&X-Api-Key=<v>,${secret:Y}, --x&API_KEY:<v>;Bearer <token>, and with a cut value", () => {
    // Act
    const actual = shownFlags([
      `--hdr,api_key:${NESTED} more`,
      `--hdr;password:${NESTED} x`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference is the literal text `${secret:NAME}`
      `--x&X-Api-Key=${NESTED},\${secret:API_TOKEN}`,
      `--name&?API_KEY:a${NESTED};Bearer ${FAKE_TOKEN}`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference is the literal text `${secret:NAME}`
      `--hdr,api_key:${NESTED} x=\${secret:Y},token=${FAKE_SECRET}`,
    ]);

    // Assert
    should(actual).deepEqual([
      hid(`--hdr,api_key:${HIDDEN}`),
      hid(`--hdr;password:${HIDDEN}`),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference is the literal text `${secret:NAME}`
      hid(`--x&X-Api-Key=${HIDDEN},\${secret:API_TOKEN}`),
      hid(`--name&?API_KEY:${HIDDEN};Bearer ${HIDDEN}`),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference is the literal text `${secret:NAME}`
      hid(`--hdr,api_key:${HIDDEN} x=\${secret:Y},token=${HIDDEN}`),
    ]);
  });

  it('should keep a raw @ outside a password, a quoted harmless value and a flag part with no secret key as written (control)', () => {
    // Arrange
    const words = [
      'https://h.example.invalid/x?redirect=a@b',
      'https://person@h.example.invalid/x@y',
      `--set=model="${FAKE_SECRET},${FAKE_SECRET}",b=2`,
      '--hdr,model:claude-opus-5-5 more',
      '--api-key:ab cd',
    ];

    // Act
    const actual = shownFlags(words);

    // Assert
    should(actual).deepEqual(words.map(as));
  });
});

// ── Review r2 of the #40 rule (M1, M2, M3, G1, and what the r3 fuzz found) ───────────────────────────

describe('resolvedEntries — the #40 rule after review r2 (M1, M2, M3, G1)', () => {
  const V = 'nested-fake-value-0000';
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference is the literal text `${secret:NAME}`
  const P = '${secret:OTHER_TOKEN}';

  it('should hide a secret-named key after a pointer in the same value, and a piece set apart from one (M1)', () => {
    // Act
    const actual = shownFlags([
      `--env API_KEY=${P} CLIENT_SECRET=${V}`,
      `--x=password=${P}?password:${V}`,
      `--header=Authorization: ${V} LOG_LEVEL=${P}`,
      '-c',
      `mcp_servers.x.env.API_KEY=${V} ${P}`,
      `--url=https://h.example.invalid/?token=${V}#${P}`,
    ]);

    // Assert
    should(actual).deepEqual([
      hid(`--env API_KEY=${P} CLIENT_SECRET=${HIDDEN}`),
      hid(`--x=password=${P}?password:${HIDDEN}`),
      hid(`--header=Authorization: ${HIDDEN} LOG_LEVEL=${P}`),
      as('-c'),
      hid(`mcp_servers.x.env.API_KEY=${HIDDEN}`),
      hid(`--url=https://h.example.invalid/?token=${HIDDEN}`),
    ]);
  });

  it('should read a key stuck to a one-letter flag when the glued reading finds another cut: -eAPI_KEY=<v>,token=<v> (M2)', () => {
    // Act
    const actual = shownFlags([
      `-eAPI_KEY=${V},token=${V}`,
      `-HAuthorization: Bearer ${V}, X-Api-Key: ${V}`,
      `-eapiKey=${V} access-token:${V}`,
    ]);

    // Assert
    should(actual).deepEqual([
      hid(`-eAPI_KEY=${HIDDEN},token=${HIDDEN}`),
      hid(`-HAuthorization: ${HIDDEN}, X-Api-Key: ${HIDDEN}`),
      hid(`-eapiKey=${HIDDEN}`),
    ]);
  });

  it("should read the last key of a glued flag's own part when its value has another cut: --hdr,api_key=<v>;y=<pointer>;token=<v> (M3)", () => {
    // Act
    const actual = shownFlags([`--hdr,api_key=${V};y=${P};token=${V}`, `--x&X-Api-Key=${V},y=${P},token=${V}`]);

    // Assert
    should(actual).deepEqual([
      hid(`--hdr,api_key=${HIDDEN};y=${P};token=${HIDDEN}`),
      hid(`--x&X-Api-Key=${HIDDEN},y=${P},token=${HIDDEN}`),
    ]);
  });

  it("should cut a token in a glued flag's own part with everything after the letter: -H<token>,API_KEY=<v> (G1)", () => {
    // Act
    const actual = shownFlags([`-H${FAKE_TOKEN},API_KEY=${V}`, `-Hghp_notarealtoken0000,API_KEY=${V}`]);

    // Assert
    should(actual).deepEqual([hid(`-H${HIDDEN}`), hid(`-H${HIDDEN}`)]);
  });

  it('should hide what the r3 fuzz found: a quoted value with a separator before a pointer, and a key stuck to its letter when #37 hides the glued value', () => {
    // Act
    const actual = shownFlags([`--opt x-api-key: '${V},${V}' apiKey=${P}`, `-cAPI_KEY:"${V}",PASSWORD='Bearer ${V}'`]);

    // Assert
    should(actual).deepEqual([
      hid(`--opt x-api-key: ${HIDDEN} apiKey=${P}`),
      hid(`-cAPI_KEY:${HIDDEN},PASSWORD=${HIDDEN}`),
    ]);
  });

  it("should hide the same shapes in an MCP server's arguments (M1, M2, M3, G1)", () => {
    // Act
    const actual = shownServer([
      `API_KEY=${P} CLIENT_SECRET=${V}`,
      `-eAPI_KEY=${V},token=${V}`,
      `--hdr,api_key=${V};y=${P};token=${V}`,
      `-H${FAKE_TOKEN},API_KEY=${V}`,
    ]);

    // Assert
    should(actual).equal(
      `run-server API_KEY=${P} CLIENT_SECRET=${HIDDEN} -eAPI_KEY=${HIDDEN},token=${HIDDEN} --hdr,api_key=${HIDDEN};y=${P};token=${HIDDEN} -H${HIDDEN}`,
    );
  });

  it('should keep a value composed with a pointer, a pointer beside a harmless key and a flag a token is glued to as before (control)', () => {
    // Arrange
    const words = [
      `--header=Authorization: Bearer ${P}`,
      `--env=API_KEY=prefix${P}`,
      `--env=API_KEY=${P}?model=short`,
      `--env=API_KEY=${P} ${P}`,
      `LOG_LEVEL=${P} model=${FAKE_SECRET}`,
      `-emodel=claude-opus-5-5,LOG_LEVEL=${P}`,
    ];

    // Act
    const actual = shownFlags([...words, `-password=${FAKE_TOKEN}`]);

    // Assert
    should(actual).deepEqual([...words.map(as), hid(`-password=${HIDDEN}`)]);
  });

  it("should cut a URL user's password whole, and as r2 did, when the user is itself a secret name and a key follows it", () => {
    // Arrange
    const words = [
      `postgres://token:${V}@db.example.invalid/x`,
      'postgres://token:short1@db.example.invalid',
      `--url=https://h.example.invalid/x,https://password:p@ss${V}@h.example.invalid;model=m,api_key=${V}`,
    ];

    // Act
    const actual = shownFlags(words);

    // Assert — the nested `token:` key reads the password as `‹hidden›` and cuts the host with it, as r2 did.
    should(actual).deepEqual([
      hid(`postgres://token:${HIDDEN}`),
      hid(`postgres://token:${HIDDEN}`),
      hid(`--url=https://h.example.invalid/x,https://password:${HIDDEN};model=m,api_key=${HIDDEN}`),
    ]);
    should(shownWordsR2(words).map(word => word.text)).deepEqual(actual.map(word => word.value));
  });

  it('should read every key around pointers in one pass, however many share a value (linear)', () => {
    // Arrange — pointers chained with no separator, with spaces, an unclosed `${…:-` run and quotes opening in turn.
    const glued = `--set=${`password=${P}?`.repeat(20_000)}`;
    const spaced = `--set=${`API_KEY=${P} `.repeat(20_000)}`;
    const defaults = `--set=${'API_KEY=${A:-'.repeat(20_000)}}`;
    const quotes = `--set=${`api_key=${P}'x `.repeat(20_000)}`;
    const started = performance.now();

    // Act
    const actual = shownFlags([glued, spaced, defaults, quotes]);

    // Assert
    should(actual.map(word => word.value)).deepEqual([glued, spaced, defaults, quotes]);
    should(performance.now() - started).be.below(2_000);
  });
});

describe('resolvedEntries — the #40 rule after review r3 (N1, L1)', () => {
  const V = 'nested-fake-value-0000';
  const B64 = 'bm90LWEtcmVhbC0wMDAw';
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference is the literal text `${secret:NAME}`
  const P = '${secret:OTHER_TOKEN}';

  it("should hide a secret-named key's value that holds = or : before a pointer later in it: Basic <b64>==, user:<v> (N1)", () => {
    // Act
    const actual = shownFlags([
      `--header=Authorization: Basic ${B64}== LOG_LEVEL=${P}`,
      `--header=Authorization: Basic ${B64}= LOG_LEVEL=${P}`,
      `--header=Authorization: Basic ${V}== X-Trace=${P}`,
      `--env API_KEY=${B64}== MODEL=${P}`,
      `API_KEY=${B64}== ${P}`,
      '-c',
      `env.PASSWORD=${V}= env.HOME=${P}`,
      `API_KEY=person:${V} ${P}`,
      `-eAuthorization: person:${V} ${P}`,
      `--header=Authorization: Basic person:${V} ${P}`,
      `--url=https://h.example.invalid/?token=person=${V}#${P}`,
      `--header=Authorization: Basic person:${V}: X-Trace: ${P}`,
    ]);

    // Assert
    should(actual).deepEqual([
      hid(`--header=Authorization: ${HIDDEN} LOG_LEVEL=${P}`),
      hid(`--header=Authorization: ${HIDDEN} LOG_LEVEL=${P}`),
      hid(`--header=Authorization: ${HIDDEN} X-Trace=${P}`),
      hid(`--env API_KEY=${HIDDEN} MODEL=${P}`),
      hid(`API_KEY=${HIDDEN} ${P}`),
      as('-c'),
      hid(`env.PASSWORD=${HIDDEN} env.HOME=${P}`),
      hid(`API_KEY=${HIDDEN} ${P}`),
      hid(`-eAuthorization: ${HIDDEN} ${P}`),
      hid(`--header=Authorization: ${HIDDEN} ${P}`),
      hid(`--url=https://h.example.invalid/?token=${HIDDEN}#${P}`),
      hid(`--header=Authorization: ${HIDDEN} X-Trace: ${P}`),
    ]);
  });

  it("should hide the same shapes in an MCP server's arguments (N1)", () => {
    // Act
    const actual = shownServer([`API_KEY=${B64}== ${P}`, `--header=Authorization: Basic person:${V} ${P}`]);

    // Assert
    should(actual).equal(`run-server API_KEY=${HIDDEN} ${P} --header=Authorization: ${HIDDEN} ${P}`);
  });

  it('should cut up to the last part before the pointer that looks like a credential, a harmless key between them too (N1)', () => {
    // Act — every part before the pointer is judged on its own, so a harmless `MODEL=…` part long enough to be a
    // secret, between the secret and the pointer, is cut with it; one too short is not, and ends no cut.
    const actual = shownFlags([`API_KEY=${V} MODEL=gpt-4o-mini ${P}`, `API_KEY=${V} x=y ${P}`]);

    // Assert
    should(actual).deepEqual([hid(`API_KEY=${HIDDEN} ${P}`), hid(`API_KEY=${HIDDEN} x=y ${P}`)]);
  });

  it('should keep a part that only points at one, or is too short, before a pointer, and a harmless key exactly (N1 control)', () => {
    // Arrange
    const words = [
      `API_KEY=$LONG_POINTER_NAME ${P}`,
      `API_KEY='$LONG_POINTER_NAME' ${P}`,
      `API_KEY="\${LONG_POINTER_NAME}" ${P}`,
      `API_KEY=short== ${P}`,
      `Authorization: Basic ${P}`,
      `--header=Authorization: Basic X-Request-Id: abcdefghijk ${P}`,
      `LOG_LEVEL=${B64}== ${P}`,
      `LOG_LEVEL=person:${V} ${P}`,
    ];

    // Act
    const actual = shownFlags(words);

    // Assert
    should(actual).deepEqual(words.map(as));
  });

  it('should judge a value that starts with a ${…} and goes on past its } as one value, whole (L1)', () => {
    // Act — only a value that IS one ${…} is no secret; this one goes on, so it is judged whole and cut whole, not
    // cut to its first piece with the text under the harmless key after it shown.
    const actual = shownFlags(['API_KEY=${A} short model=abcdefghijk', '--env=API_KEY=${A}?model=abcdefghijk']);

    // Assert
    should(actual).deepEqual([hid(`API_KEY=${HIDDEN}`), hid(`--env=API_KEY=${HIDDEN}`)]);
  });
});

describe('resolvedEntries — the #40 rule after review r4 (B1, B2)', () => {
  const V = 'nested-fake-value-0000';
  const B64 = 'bm90LWEtcmVhbC0wMDAw';
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference is the literal text `${secret:NAME}`
  const P = '${secret:OTHER_TOKEN}';

  it('#40 B1 should hide a secret-named flag’s value whatever pointer follows it: the word after the flag', () => {
    // Act — the value of each, set apart from a pointer by a space or `#`, on either side of it.
    const actual = shownFlags([
      '--token',
      `${V} ${P}`,
      '--token',
      `${P} ${V}`,
      '--client-secret',
      `Basic ${V}#${P}`,
      '--api-key',
      `short ${V}== ${P}`,
      '--password',
      `${B64}== ${P}`,
      '--token',
      `${V}  ${P}`,
    ]);

    // Assert — the flag stays, the pointer stays when it stands apart from a padded value.
    should(actual).deepEqual([
      as('--token'),
      hid(HIDDEN),
      as('--token'),
      hid(HIDDEN),
      as('--client-secret'),
      hid(HIDDEN),
      as('--api-key'),
      hid(`${HIDDEN} ${P}`),
      as('--password'),
      hid(`${HIDDEN} ${P}`),
      as('--token'),
      hid(HIDDEN),
    ]);
  });

  it('#40 B1 should hide a secret-named flag’s value whatever pointer follows it: the value glued by a space or =', () => {
    // Act
    const actual = shownFlags([
      `--token ${V} ${P}`,
      `--token=${V} ${P}`,
      `--client-secret Basic ${V}#${P}`,
      `--password ${B64}== ${P}`,
      `--api-key ${P} ${V}`,
      `--token\t${V} ${P}`,
    ]);

    // Assert
    should(actual).deepEqual([
      hid(`--token ${HIDDEN}`),
      hid(`--token=${HIDDEN}`),
      hid(`--client-secret ${HIDDEN}`),
      hid(`--password ${HIDDEN} ${P}`),
      hid(`--api-key ${HIDDEN}`),
      hid(`--token\t${HIDDEN}`),
    ]);
  });

  it("#40 B1 should hide the same shapes in an MCP server's arguments", () => {
    // Act
    const actual = shownServer(['--token', `${V} ${P}`, `--password ${V} ${P}`]);

    // Assert
    should(actual).equal(`run-server --token ${HIDDEN} --password ${HIDDEN}`);
  });

  it('#40 B1 should keep a flag value that is composed with the pointer, too short, or under a flag that names no secret (control)', () => {
    // Arrange — `-k` is a one-letter name (the declared `-p<password>` GAP), `--model` a harmless one.
    const words = [
      '--token',
      `Bearer ${P}`,
      '--token',
      `prefix${P}`,
      '--token',
      `${P} short`,
      '--token',
      `${P}`,
      '--model',
      `${V} ${P}`,
      '-k',
      `${V} ${P}`,
      `--model ${V} ${P}`,
      `--verbose=${V} ${P}`,
      `--token Bearer ${P}`,
      `--token ${P}`,
    ];

    // Act
    const actual = shownFlags(words);

    // Assert
    should(actual).deepEqual(words.map(as));
  });

  it('#40 B2 should hide base64 padding after a pointer, in a secret-named key’s value', () => {
    // Act
    const actual = shownFlags([
      `API_KEY=${P} ${B64}==`,
      `API_KEY=${P} ${B64}=`,
      `API_KEY=${P} Basic ${B64}==`,
      `Authorization: ${P} ${B64}==`,
      `API_KEY=${P} ${V} ${B64}== ${P}`,
      `API_KEY=${P} dXNlcjpw/Zm9v+YmFyYmF6==`,
      `--env=API_KEY=${P} ${B64}== MODEL=gpt-4o-mini`,
      `--header=Authorization: ${P} ${B64}= LOG_LEVEL=${P}`,
    ]);

    // Assert — the key and a harmless key after the value stay.
    should(actual).deepEqual([
      hid(`API_KEY=${HIDDEN}`),
      hid(`API_KEY=${HIDDEN}`),
      hid(`API_KEY=${HIDDEN}`),
      hid(`Authorization: ${HIDDEN}`),
      hid(`API_KEY=${HIDDEN}`),
      hid(`API_KEY=${HIDDEN}`),
      hid(`--env=API_KEY=${HIDDEN} MODEL=gpt-4o-mini`),
      hid(`--header=Authorization: ${HIDDEN} LOG_LEVEL=${P}`),
    ]);
  });

  it('#40 B2 should hide padding after a pointer in an MCP server’s arguments and after a secret-named flag', () => {
    // Act
    const actual = shownServer([`API_KEY=${P} ${B64}==`, '--token', `${P} ${B64}==`]);

    // Assert
    should(actual).equal(`run-server API_KEY=${HIDDEN} --token ${HIDDEN}`);
  });

  it('#40 B2 should keep a harmless key after a pointer, and a part too short to be a secret, exactly (control)', () => {
    // Arrange — `MODEL=gpt-4o-mini` is its own key and `FOO= bar` an empty one with a short part after it: neither is
    // padding.
    const words = [
      `API_KEY=${P} MODEL=gpt-4o-mini`,
      `API_KEY=${P} FOO= bar`,
      `API_KEY=${P} FOO==`,
      `API_KEY=${P} short==`,
      `LOG_LEVEL=${P} ${B64}==`,
      `API_KEY=${P} x= y`,
    ];

    // Act
    const actual = shownFlags(words);

    // Assert
    should(actual).deepEqual(words.map(as));
  });

  it('#40 B2 should still show a value with a pointer after it exactly as r4 did where nothing is padded (control)', () => {
    // Act — the pointer stays when it stands apart from a padded secret before it (N1), and goes with a plain one.
    const actual = shownFlags([`API_KEY=${B64}== ${P}`, `API_KEY=${P} ${B64}`, `API_KEY=${V} ${P}`]);

    // Assert
    should(actual).deepEqual([hid(`API_KEY=${HIDDEN} ${P}`), hid(`API_KEY=${HIDDEN}`), hid(`API_KEY=${HIDDEN}`)]);
  });
});
