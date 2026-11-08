import { describe, it } from 'bun:test';
import should from 'should';
import { type ResolvedProfile, type ResolveInput, resolveProfile } from '../../../daemon/lib/account/layering.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { resolvedEntries } from '../../../daemon/lib/service/resolved-view.ts';

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
