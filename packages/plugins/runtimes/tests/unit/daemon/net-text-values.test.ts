/**
 * CFG-LEAK (ii) fix 3: an instructions or a hooks text is also read by the write rule as VALUES. An instruction
 * Runtimes writes keeps its text IN the component YAML (the flag rule reads a string with blanks as words), and a hooks
 * file is a JSON document judged by its parsed values. So the detail's `content` withholds, besides the lines the text
 * test refuses, (a) each instructions line the flag rule refuses, alone or with the word that ends the line before it,
 * and (b) the lines of every path of the parsed hooks document that the write rule refuses (a refused list item
 * withholds its whole list). Fake values only.
 *
 * Per-test limits (testing standard): the timing test reads 6 shapes at 128 and 256 KiB, each a second or less
 * alone; the repo prose test reads every `docs/**` markdown file once (about 6 s alone): both carry an explicit limit.
 */
import { describe, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';
import should from 'should';
import { findFlagSecrets, findRawSecrets, rawTextHoldsSecret } from '@ferretry/std/credential-words';
import { componentCatalog, WITHHELD_LINE } from '../../../daemon/lib/service/catalog.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { ratioOf } from '@ferretry/std/testing/linear-time';

const V = 'Zk3pQ9vXw2LmN7rT';
const V2 = 'Qw8rTy3uIo5pAs7dFg2h';
const LONG40 = 'Zk3pQ9vXw2LmN7rTHy8cBt4Fg6SdJ1uEqW5eR0tY';
const VALUES = [V, V2, LONG40];
const windowsOf = (secret: string): readonly string[] =>
  Array.from({ length: Math.max(0, secret.length - 7) }, (_, at) => secret.slice(at, at + 8));
const WINDOWS = VALUES.flatMap(windowsOf);
const leaks = (text: string): boolean => WINDOWS.some(window => text.includes(window));

const FACTS = {
  format: 'present',
  machineName: 'box',
  tools: { claude: undefined, codex: undefined },
  runningSessions: 0,
  userHome: '/home/person',
  acceptsAutoPermissionMode: true,
} as const;

/** What the detail shows for an instructions text: kept in a file, or held in the component YAML. */
function instructionsShown(text: string, held: boolean): { text: string; redacted: boolean } {
  const model = parseAccountModel({
    version: 1,
    components: { instructions: { notes: held ? { text } : { file: 'notes.md' } } },
  });
  const content = componentCatalog(model, { ...FACTS, instructionBodies: { notes: text } }).kinds.flatMap(
    kind => kind.components,
  )[0]?.content;
  if (content?.form !== 'text') throw new Error('expected text content');
  return { text: content.text, redacted: content.redacted };
}

/** What the detail shows for a hooks file holding `text`. */
function hooksShown(text: string): { text: string; redacted: boolean } {
  const model = parseAccountModel({
    version: 1,
    components: { hooks: { notes: { harness: 'claude', file: 'components/hooks/notes.json' } } },
  });
  const content = componentCatalog(model, { ...FACTS, hooksTexts: { notes: text } }).kinds.flatMap(
    kind => kind.components,
  )[0]?.content;
  if (content?.form !== 'text') throw new Error('expected text content');
  return { text: content.text, redacted: content.redacted };
}

/** Whether the write rule refuses `document` (its raw rule or its flag rule), the way the kernel reads a file. */
const refused = (document: unknown): boolean =>
  findRawSecrets(document).length > 0 || findFlagSecrets(document).length > 0;

const lineCount = (text: string): number => text.split('\n').length;

/** The instructions the reviewer's probe found shown while the write rule refused them, and three variants each. */
const PROSE: Readonly<Record<string, readonly string[]>> = {
  'a flag and its value in prose': [
    `Sign in with mytool --token ${V} then run it.`,
    `Run \`tool --token ${V2}\` first.`,
    `  - mytool --password ${V}`,
    `use --api-key=${LONG40} in the docs`,
  ],
  'a url password': [
    `clone https://bob:${V}@git.example.com/x.git`,
    `git remote add o https://alice:${V2}@h.example.com/r.git`,
    `[repo](https://carol:${LONG40}@host.example.com/p)`,
    `fetch "https://dan:${V}@h.example.org/a/b" now`,
  ],
  'a path to a tool and its flag': [
    `/home/bob/bin/tool --token ${V}`,
    `/Users/amy/bin/x --token ${V2}`,
    `~/bin/y --password ${V}`,
    `/opt/tool/run --client-secret ${LONG40}`,
  ],
  'a flag at the end of a line and its value on the next': [
    `mytool --token\n${V}`,
    `run it with --password\n  ${V2} please`,
    `x --api-key\n${LONG40}\ny`,
  ],
};

describe('instructions lines the write rule refuses as values are withheld', () => {
  for (const [name, texts] of Object.entries(PROSE)) {
    for (const [at, text] of texts.entries()) {
      for (const held of [false, true]) {
        it(`should show no value of ${name} (${String(at + 1)}, ${held ? 'held in the YAML' : 'in a file'})`, () => {
          // Arrange: the case is a real one, the write rule refuses the text as a value
          should(refused({ text })).be.true();

          // Act
          const shown = instructionsShown(text, held);

          // Assert
          should(leaks(shown.text)).be.false();
          should(shown.redacted).be.true();
          should(lineCount(shown.text)).equal(lineCount(text));
        });
      }
    }
  }

  it('should withhold a flag line alone and keep its neighbours', () => {
    // Act
    const shown = instructionsShown(`intro\nSign in with mytool --token ${V}\noutro`, false);

    // Assert
    should(shown.text).equal(`intro\n${WITHHELD_LINE}\noutro`);
  });

  for (const [name, text] of Object.entries({
    'a placeholder flag value': 'Sign in with mytool --token <TOKEN> then run it.',
    'a pointer flag value': 'Run mytool --token ${secret:MYTOOL_TOKEN} then.',
    'an authorization pointer': 'curl -H "Authorization: Bearer ${secret:API}" https://api.example.com',
    'a 40-char git sha in prose': 'Fixed in commit 4389fa6d1e0c5b8a7f3d2c1b0a9e8d7c6b5a4f3e of the repo.',
    'a url with a user only': 'clone https://user@git.example.com/x.git',
    'a url with a pointer password': 'clone https://u:${secret:GIT}@h.example.com/x.git',
    'a flag name alone at the end of a line': 'pass the --token\nflag to the tool',
  })) {
    it(`should show ${name} as written`, () => {
      // Arrange: the write rule accepts it
      should(refused({ text })).be.false();

      // Act
      const shown = instructionsShown(text, true);

      // Assert
      should(shown.text).equal(text);
      should(shown.redacted).be.false();
    });
  }
});

/** A hooks document in the shapes the harness reads, around one `command` and its `args`. */
const hook = (command: string, args?: readonly string[]): unknown => ({
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command, ...(args ? { args } : {}) }] }] },
});

const HOOKS: Readonly<Record<string, readonly unknown[]>> = {
  'a flag and its value in the command': [
    hook(`tool --token ${V}`),
    hook(`/opt/x/run --password ${V2} --quiet`),
    hook(`notify --api-key=${LONG40}`),
  ],
  'an env assignment in the command': [
    hook(`API_KEY=${V} notify`),
    hook(`env DB_PASSWORD=${V2} run`),
    hook(`GITHUB_TOKEN=${LONG40} gh pr list`),
  ],
  'a flag and its value as two words of the args': [
    hook('tool', ['--token', V]),
    hook('tool', ['--quiet', '--password', V2, '--json']),
    hook('tool', ['-e', `API_KEY=${LONG40}`]),
  ],
  'a url password in the command': [
    hook(`curl https://bob:${V}@h.example.com/x`),
    hook(`git clone https://amy:${V2}@git.example.com/y.git`),
    hook(`wget https://zed:${LONG40}@files.example.org/z`),
  ],
  'a credential under a plain key': [
    { env: { apiToken: V }, hooks: {} },
    { env: { DB_PASSWORD: V2 }, hooks: {} },
    { auth: { client_secret: LONG40 } },
  ],
};

/** The same document laid out three ways: indented by two, indented by a tab, and on one line. */
const layouts = (document: unknown): readonly string[] => [
  JSON.stringify(document, undefined, 2),
  JSON.stringify(document, undefined, '\t'),
  JSON.stringify(document),
];

describe('hooks lines the write rule refuses as parsed values are withheld', () => {
  for (const [name, documents] of Object.entries(HOOKS)) {
    for (const [at, document] of documents.entries()) {
      for (const [layout, text] of layouts(document).entries()) {
        it(`should show no value of ${name} (${String(at + 1)}, layout ${String(layout + 1)})`, () => {
          // Arrange: a real case, the write rule refuses the parsed document
          should(refused(document)).be.true();

          // Act
          const shown = hooksShown(text);

          // Assert
          should(leaks(shown.text)).be.false();
          should(shown.redacted).be.true();
          should(lineCount(shown.text)).equal(lineCount(text));
        });
      }
    }
  }

  it('should withhold the whole args list of a flag and its value and keep the lines around it', () => {
    // Arrange
    const text = JSON.stringify(hook('tool', ['--token', V]), undefined, 2);

    // Act
    const shown = hooksShown(text).text.split('\n');

    // Assert: the matcher line and the type line stay, the command line stays, the two words of the list go
    should(shown.filter(line => line === WITHHELD_LINE).length).be.above(0);
    should(shown.some(line => line.includes('"matcher": "Bash"'))).be.true();
    should(shown.some(line => line.includes('"command": "tool"'))).be.true();
    should(shown.some(line => line.includes('--token'))).be.false();
  });

  it('should withhold the command line of a flag secret and keep a sibling hook as written', () => {
    // Arrange
    const text = JSON.stringify(
      {
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command: `tool --token ${V}` },
                { type: 'command', command: 'echo done' },
              ],
            },
          ],
        },
      },
      undefined,
      2,
    );

    // Act
    const shown = hooksShown(text).text;

    // Assert
    should(shown).containEql('"command": "echo done"');
    should(shown).containEql(WITHHELD_LINE);
    should(leaks(shown)).be.false();
  });

  it('should keep a hook whose flag value is a placeholder or a pointer exactly as written', () => {
    // Arrange: the write rule accepts every one of these
    const texts = [
      JSON.stringify(hook('tool --token <TOKEN>'), undefined, 2),
      JSON.stringify(hook('tool --token ${secret:X}'), undefined, 2),
      JSON.stringify(hook('tool', ['--token', '<TOKEN>']), undefined, 2),
      JSON.stringify(hook('tool', ['--token', '${secret:X}']), undefined, 2),
      JSON.stringify(hook('curl -H "Authorization: Bearer ${secret:X}" https://h.example.com'), undefined, 2),
      JSON.stringify(hook('git log 4389fa6d1e0c5b8a7f3d2c1b0a9e8d7c6b5a4f3e'), undefined, 2),
      JSON.stringify(hook('curl https://user@h.example.com/x'), undefined, 2),
      JSON.stringify(hook('curl https://u:${secret:X}@h.example.com/x'), undefined, 2),
    ];

    for (const text of texts) {
      // Act
      const shown = hooksShown(text);

      // Assert
      should(refused(JSON.parse(text))).be.false();
      should(shown.text).equal(text);
      should(shown.redacted).be.false();
    }
  });

  it('should keep a hooks text that is not JSON on the line net alone', () => {
    // Arrange
    const text = `not json at all\nkey: ${LONG40}\n--token ${V}`;

    // Act
    const shown = hooksShown(text);

    // Assert: the line the text test refuses goes, and the flag line of prose is not judged in a hooks file
    should(shown.text.split('\n')[0]).equal('not json at all');
    should(shown.text.split('\n')[1]).equal(WITHHELD_LINE);
  });

  it('should withhold the whole text of a refused document nested past the scan depth', () => {
    // Arrange
    let nested: unknown = { command: `tool --token ${V}` };
    for (let depth = 0; depth < 400; depth += 1) nested = { a: nested };
    const text = JSON.stringify(nested, undefined, 1);

    // Act
    const shown = hooksShown(text);

    // Assert
    should(leaks(shown.text)).be.false();
    should(shown.text.split('\n').every(line => line === WITHHELD_LINE)).be.true();
  });
});

describe('the nets withhold nothing the write rule accepts', () => {
  it('should withhold no line of the repo prose that the write rule accepts', () => {
    // Arrange
    const root = join(import.meta.dir, '../../../../../..');
    const files = [
      ...new Glob('docs/**/*.md').scanSync({ cwd: root }),
      ...['CLAUDE.md', 'AGENTS.md'].filter(file => existsSync(join(root, file))),
    ];
    let lines = 0;
    const overWithheld: string[] = [];

    // Act
    for (const file of files) {
      const text = readFileSync(join(root, file), 'utf8');
      const shown = instructionsShown(text, true).text.split('\n');
      const units = text.split('\n');
      units.forEach((unit, at) => {
        lines += 1;
        if (shown[at] !== WITHHELD_LINE) return;
        const line = unit.replace(/\r$/u, '');
        const words = (units[at - 1] ?? '').trimEnd().split(/\s+/u);
        const last = words.at(-1) ?? '';
        const refusedHere =
          rawTextHoldsSecret(line) ||
          findFlagSecrets({ text: line }).length > 0 ||
          (last !== '' && findFlagSecrets({ text: `${last}\n${line}` }).length > 0);
        if (!refusedHere) overWithheld.push(`${file}:${String(at + 1)}`);
      });
    }

    // Assert
    should(lines).be.above(1000);
    should(overWithheld).deepEqual([]);
  }, 60_000);

  it('should stay linear to 256 KiB on every shape of text and of document', () => {
    // Arrange
    const shapes: Readonly<Record<string, (size: number) => string>> = {
      'one very long instructions line': size => `key: ${'a1B2'.repeat(size / 4)}`,
      'many short instructions lines': size => 'ab\n'.repeat(size / 3),
      'many instructions lines each holding a flag secret': size => `run --token ${V}\n`.repeat(Math.ceil(size / 23)),
      'one very long hooks command': size =>
        JSON.stringify(hook(`tool ${'a1B2 '.repeat(size / 5)} --token ${V}`), undefined, 2),
      'a hooks args list of 50,000 words': size =>
        JSON.stringify(
          hook('tool', ['--token', V, ...Array.from({ length: size / 8 }, () => 'ab'), '--x']),
          undefined,
          2,
        ),
      'many hooks each holding a flag secret': size =>
        JSON.stringify(
          Array.from({ length: Math.ceil(size / 40) }, () => ({ command: `t --token ${V}` })),
          undefined,
          2,
        ),
    };
    const shown = (name: string, text: string): void => {
      if (name.includes('hooks')) hooksShown(text);
      else instructionsShown(text, true);
    };

    // Act + Assert: the ratio of 256 to 128 KiB stays under 3 (a quadratic net would give about 4).
    for (const [name, make] of Object.entries(shapes)) {
      const small128 = make(128 * 1024);
      const large256 = make(256 * 1024);
      const ratio = ratioOf(
        () => shown(name, large256),
        () => shown(name, small128),
      );
      should(ratio).be.below(3, name);
    }
  }, 120_000);
});
