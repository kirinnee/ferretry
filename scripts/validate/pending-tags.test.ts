import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { contextFor } from '../gen/lib/check.ts';
import {
  type KnipConfig,
  type KnipIgnore,
  type PackageRef,
  type TagInput,
  type TaggedFile,
  checkWith,
  knipIgnores,
  knipShapeFindings,
  tagFindings,
  tagsOf,
} from './pending-tags.ts';

const pending = {
  format: 1 as const,
  pending: ['vault', 'kernel2'],
  halves: {},
  reasons: {
    vault: [
      'GAP(access): the export screen waits for the passkey mount; app/export-sheet.tsx stays until then',
      'GAP(kernel): no event route yet',
    ],
    kernel2: ['GAP(kernel): the sync worker waits for the queue; app/skeleton.ts stays until then'],
  },
};
const file = (
  text: string,
  owner: string | undefined = 'vault',
  where = 'packages/plugins/vault/app/x.ts',
  rowOwner: string | undefined = owner,
): TaggedFile => ({
  where,
  text,
  owner,
  rowOwner,
  manifest: "export const manifest = { ui: { settings: [{ id: 'secrets-tab' }] }, routes: { 'vault.export': {} } };",
});
const shellFile = (text: string, rowOwner: string | undefined = 'app-shell'): TaggedFile => ({
  ...file(text, 'none', 'packages/app/src/x.ts'),
  owner: undefined,
  rowOwner,
});
const keptRows = new Map([
  ['S68', { owner: 'vault', with: [] as readonly string[] }],
  ['G90', { owner: 'kernel', with: ['vault'] }],
  ['A1', { owner: 'app-shell', with: [] as readonly string[] }],
]);
const run = (files: readonly TaggedFile[], ignores: readonly KnipIgnore[] = [], over: Partial<TagInput> = {}) =>
  tagFindings({
    files,
    ignores,
    pending,
    keptRows,
    docExists: path => path === 'docs/relay-protocol.md',
    ...over,
  }).map(f => f.message);
const tagged = (text: string, where = 'x.ts') => tagsOf(where, text);

describe('pending-tags: reading comments', () => {
  test('reads tags from comments only, with their lines', () => {
    const read = tagged("const a = '@pending vault: x';\n/** @pending vault: no event route yet */\n// @public S68\n");
    expect(read.tags).toEqual([
      { kind: 'pending', rest: 'vault: no event route yet', line: 2 },
      { kind: 'public', rest: 'S68', line: 3 },
    ]);
  });

  test('a tag in a plain string or a template literal is no tag', () => {
    expect(tagged("const a = '/** @pending vault: totally bogus gap */';\nconst b = `// @public S68`;").tags).toEqual(
      [],
    );
  });

  test('an apostrophe in JSX text does not hide the comment after it (.tsx)', () => {
    const read = tagged(
      "const a = <p>Don't</p>;\n/** @pending vault: totally bogus gap */\nexport const b = 1;\nconst c = <p>it's</p>;\n",
      'x.tsx',
    );
    expect(read.error).toBeUndefined();
    expect(read.tags).toEqual([{ kind: 'pending', rest: 'vault: totally bogus gap', line: 2 }]);
  });

  test('a quote inside a regex class does not hide the comment after it', () => {
    const read = tagged(
      "const re = /['\"]/g;\n/** @pending vault: totally bogus gap */\nexport const b = 1;\nconst s = 'x';\n",
    );
    expect(read.tags).toEqual([{ kind: 'pending', rest: 'vault: totally bogus gap', line: 2 }]);
  });

  test('a nested template does not hide the comment after it', () => {
    const read = tagged('const t = `a ${`b ${1} "`} \'`;\n// @public S68\nexport const b = 1;\n');
    expect(read.tags).toEqual([{ kind: 'public', rest: 'S68', line: 2 }]);
  });

  test('a // inside a regex literal is no phantom comment', () => {
    const read = tagged('const re = /a\\/\\/ @pending vault: phantom gap here/;\nexport const b = 1;\n');
    expect(read.tags).toEqual([]);
  });

  test('a multi-line JSDoc reads the tag on its own line', () => {
    const read = tagged('/**\n * Keeps the export.\n * @pending vault: no event route yet\n */\nexport const a = 1;\n');
    expect(read.tags).toEqual([{ kind: 'pending', rest: 'vault: no event route yet', line: 3 }]);
  });

  test('a tag in the middle of prose is no tag (anchored at the start of a comment line)', () => {
    const read = tagged(
      '// mail kirin@public.com for help\n/** the @pending tag is described in docs */\n// @public S68 real\n',
    );
    expect(read.tags).toEqual([{ kind: 'public', rest: 'S68 real', line: 3 }]);
  });

  test('a file that does not parse is an error, and a finding', () => {
    const read = tagged('const = ;\n// @pending vault: no event route yet\n');
    expect(read.error).toBeDefined();
    expect(read.tags).toEqual([]);
    expect(run([file('export const = ;\n// @public S68')])).toEqual([
      expect.stringContaining('does not parse, so its @pending / @public tags cannot be read'),
    ]);
  });
});

describe('pending-tags: @pending', () => {
  test('naming an open gap of its own pending package passes, case and spacing aside', () => {
    expect(run([file('/** @pending vault: No  EVENT route yet */\nexport const a = 1;')])).toEqual([]);
  });

  test('a gap that starts mid-word is not found', () => {
    expect(run([file('/** @pending vault: vent route yet and more */')])).toEqual([
      '@pending gap "vent route yet and more" is in none of pendingReasons.vault in ports-pending.json',
    ]);
  });

  test('a gap in no pendingReasons line is a finding', () => {
    expect(run([file('/** @pending vault: someday maybe never */')])).toEqual([
      '@pending gap "someday maybe never" is in none of pendingReasons.vault in ports-pending.json',
    ]);
  });

  test('a thin gap is a finding: one character, one word, a bare GAP(x), two words, too few characters', () => {
    const thin = (gap: string) => run([file(`/** @pending vault: ${gap} */`)]);
    for (const gap of ['a', 'GAP', 'the', 'GAP(kernel)', 'no event', 'no event rou'])
      expect(thin(gap)).toEqual([expect.stringContaining('is too thin')]);
  });

  test('a gap wrapped over two lines is read as its first line only, so the short first line is thin', () => {
    expect(run([file('/**\n * @pending vault: no event\n * route yet\n */')])).toEqual([
      expect.stringContaining('is too thin'),
    ]);
  });

  test('left in a package that has left ports-pending is a finding', () => {
    expect(
      run([file('/** @pending board: no event route yet */', 'board', 'packages/plugins/board/app/x.ts')]),
    ).toEqual(['board has left ports-pending.json; wire or delete what this @pending kept']);
  });

  test('naming another owner, an unowned package, or no gap is a finding', () => {
    expect(run([file('/** @pending kernel2: no event route yet */')])).toEqual([
      '@pending names "kernel2", but this file belongs to "vault"',
    ]);
    expect(run([{ ...file('/** @pending vault: no event route yet */'), owner: undefined }])).toEqual([
      '@pending in a package that is no subsystem; only a pending port may keep code this way',
    ]);
    expect(run([file('/** @pending */')])).toEqual(['@pending must read "@pending <owner>: <the gap it waits for>"']);
  });
});

describe('pending-tags: @public in a subsystem', () => {
  test('a kept row of this package, or a surface written in the manifest, passes', () => {
    expect(run([file('/** @public S68 enforcer */\n/** @public surface secrets-tab */')])).toEqual([]);
  });

  test('a row whose `with` names this package passes', () => {
    expect(run([file('/** @public G90 */')])).toEqual([]);
  });

  test('a row of another package is a finding', () => {
    expect(run([file('/** @public A1 because */')])).toEqual([
      '@public names A1, a row of another package; name a row vault owns',
    ]);
  });

  test('one valid id beside nonsense passes only when the id is this package`s', () => {
    expect(run([file('/** @public see S68, nonsense */')])).toEqual([]);
    expect(run([file('/** @public see A1, nonsense */')])).toEqual([
      '@public names A1, a row of another package; name a row vault owns',
    ]);
  });

  test('no reason, a reason with no id, an unknown id and an unwritten surface are findings', () => {
    const need =
      '@public needs a reason: a kept guarantee row id of this package, or "surface <name>" from the manifest';
    expect(run([file('/** @public */')])).toEqual([need]);
    expect(run([file('/** @public kept for later */')])).toEqual([need]);
    expect(run([file('/** @public S9999 */')])).toEqual([
      '@public names S9999, none of them a kept row of docs/rebuild/guarantees.tsv',
    ]);
    expect(run([file('/** @public surface secrets */')])).toEqual([
      '@public surface "secrets" is not written in this package\'s manifest',
    ]);
  });
});

describe('pending-tags: @public in a package with no subsystem id', () => {
  const need =
    '@public needs a reason: a kept guarantee row id of this package, a § section ref, or a docs/… path that exists';

  test('no reason and a stub reason are findings (they were skipped before)', () => {
    expect(run([shellFile('/** @public */')])).toEqual([need]);
    expect(run([shellFile('/** @public because I said so */')])).toEqual([need]);
  });

  test('a § section ref, a docs path that exists, or a row of its own owner passes', () => {
    expect(run([shellFile('/** @public A plugin screen mounts the panels (§5.2). */')])).toEqual([]);
    expect(run([shellFile('/** @public A docs/relay-protocol.md number kept with the copy. */')])).toEqual([]);
    expect(run([shellFile('/** @public A1 */')])).toEqual([]);
  });

  test('a docs path that does not exist, and a row of another package, are findings', () => {
    expect(run([shellFile('/** @public see docs/nowhere.md */')])).toEqual([
      '@public names docs/nowhere.md, which does not exist',
    ]);
    expect(run([shellFile('/** @public S68 */')])).toEqual([
      '@public names S68, a row of another package; name a row app-shell owns',
    ]);
  });

  test('std has no rows: a § ref passes, a row id does not', () => {
    expect(run([{ ...shellFile('/** @public see §3.1 */'), rowOwner: undefined }])).toEqual([]);
    expect(run([{ ...shellFile('/** @public S68 */'), rowOwner: undefined }])).toEqual([
      '@public names S68, a row of another package; name a row this package owns',
    ]);
  });
});

describe('pending-tags: knip ignore', () => {
  const ignore = (
    owners: (string | undefined)[],
    paths: string[],
    workspace = 'packages/plugins/vault',
  ): KnipIgnore => ({
    config: 'knip.json',
    workspace,
    owners,
    paths,
  });

  test('a pending package must have a gap line naming the path; a ported one is a finding', () => {
    expect(run([], [ignore(['vault'], ['app/export-sheet.tsx'])])).toEqual([]);
    expect(run([], [ignore(['vault'], ['app/other.tsx'])])).toEqual([
      '"app/other.tsx" is ignored, but no pendingReasons.vault line in ports-pending.json names it',
    ]);
    expect(run([], [ignore(['board'], ['app/x.tsx'])])).toEqual([
      '"app/x.tsx" is ignored, but board has left ports-pending.json; wire or delete it',
    ]);
  });

  test('the CLI, the app shell and std (no id) are judged by knip alone', () => {
    expect(run([], [ignore([undefined], ['src/x.ts'], 'packages/cli')])).toEqual([]);
  });

  test('a glob key over two pending packages: the one that does not name the path is a finding', () => {
    expect(run([], [ignore(['vault', 'kernel2'], ['app/skeleton.ts'], 'packages/plugins/*')])).toEqual([
      '"app/skeleton.ts" is ignored, but no pendingReasons.vault line in ports-pending.json names it',
    ]);
  });

  test('a path too short, or only a substring of a word, is a finding', () => {
    expect(run([], [ignore(['vault'], ['e'])])).toEqual([
      '"e" is ignored for vault, but is too short to be named (6 characters or more)',
    ]);
    expect(run([], [ignore(['vault'], ['export-sheet'])])).toEqual([
      '"export-sheet" is ignored, but no pendingReasons.vault line in ports-pending.json names it',
    ]);
    expect(run([], [ignore(['vault'], ['sheet.tsx'])])).toEqual([
      '"sheet.tsx" is ignored, but no pendingReasons.vault line in ports-pending.json names it',
    ]);
  });

  test('knipIgnores resolves glob, ./ and trailing-slash keys to the packages they match', () => {
    const packages: PackageRef[] = [
      { rel: 'packages/plugins/vault', id: 'vault' },
      { rel: 'packages/plugins/board', id: 'board' },
      { rel: 'packages/app', id: undefined },
    ];
    const configs: KnipConfig[] = [
      {
        config: 'knip.json',
        json: {
          workspaces: {
            'packages/plugins/*': { ignore: ['app/skeleton.ts'] },
            './packages/plugins/vault/': { ignore: ['a.ts'] },
            'packages/app': { ignore: 'b.ts' },
            '.': { ignore: ['c.ts'] },
            'packages/nope': { ignore: ['d.ts'] },
          },
        },
      },
    ];
    expect(knipIgnores(configs, packages).map(i => [i.workspace, i.owners, i.paths])).toEqual([
      ['packages/plugins/*', ['vault', 'board'], ['app/skeleton.ts']],
      ['./packages/plugins/vault/', ['vault'], ['a.ts']],
      ['packages/app', [undefined], ['b.ts']],
      ['.', [undefined], ['c.ts']],
      ['packages/nope', [], ['d.ts']],
    ]);
  });
});

describe('pending-tags: knip config shape', () => {
  const packages: PackageRef[] = [
    { rel: 'packages/plugins/vault', id: 'vault' },
    { rel: 'packages/cli', id: undefined },
  ];
  const cfg = (json: unknown): KnipConfig[] => [{ config: 'knip.json', json }];
  const shape = (json: unknown, allowed: ReadonlyMap<string, string> = new Map()) =>
    knipShapeFindings(cfg(json), packages, allowed);

  test('the plain shape passes: entry/project/ignore, tests, views and bins, rules, tags, plugins switched off', () => {
    expect(
      shape({
        $schema: 'x',
        workspaces: {
          '.': { project: ['scripts/*.ts'] },
          'packages/plugins/*': { entry: ['tests/**/*.test.{ts,tsx}', 'app/views/*.tsx'], project: ['**/*.ts'] },
          'packages/cli': { entry: ['bin/*.ts'], ignore: ['src/x.ts'] },
        },
        rules: { files: 'error' },
        tags: ['-pending'],
        bun: false,
      }),
    ).toEqual([]);
  });

  test('every other keep-alive key is a finding', () => {
    const messages = (json: unknown) => shape(json).map(f => f.message);
    for (const [name, json] of [
      ['ignoreFiles', { workspaces: { 'packages/cli': { ignoreFiles: ['a.ts'] } } }],
      ['ignoreIssues', { ignoreIssues: { 'packages/cli/a.ts': ['exports'] } }],
      ['ignoreMembers', { workspaces: { 'packages/cli': { ignoreMembers: ['m'] } } }],
      ['ignoreExportsUsedInFile', { ignoreExportsUsedInFile: true }],
      ['ignore', { ignore: ['a.ts'] }],
      ['ignoreWorkspaces', { ignoreWorkspaces: ['packages/cli'] }],
      ['an unknown key', { somethingNew: 1 }],
    ] as const)
      expect(messages(json).length, name).toBeGreaterThan(0);
    expect(messages({ workspaces: { 'packages/cli': { entry: ['src/dead.ts'] } } })).toEqual([
      expect.stringContaining('entry "src/dead.ts" keeps code alive'),
    ]);
  });

  test('an entry that is a test, a view or a bin file is fine; a string entry is read too', () => {
    expect(shape({ workspaces: { 'packages/cli': { entry: 'bin/*.ts' } } })).toEqual([]);
    expect(shape({ workspaces: { 'packages/cli': { entry: 'src/dead.ts' } } })).toHaveLength(1);
  });

  test('ALLOWED_KNIP lets a named setting through, and an entry nothing uses is a finding (shrink-only)', () => {
    const json = { workspaces: { 'packages/cli': { entry: ['src/dead.ts'] } }, ignoreIssues: { 'a.ts': ['x'] } };
    const allowed = new Map([
      ['knip.json#workspaces["packages/cli"].entry:src/dead.ts', 'built by path'],
      ['knip.json#ignoreIssues["a.ts"]', 'an alias'],
    ]);
    expect(shape(json, allowed)).toEqual([]);
    expect(shape({ workspaces: { 'packages/cli': {} } }, allowed).map(f => f.message)).toEqual([
      'ALLOWED_KNIP "knip.json#workspaces["packages/cli"].entry:src/dead.ts" matches no knip setting any more; delete the entry',
      'ALLOWED_KNIP "knip.json#ignoreIssues["a.ts"]" matches no knip setting any more; delete the entry',
    ]);
  });

  test('a workspace key matching no package is a finding; the root and globs that match are not', () => {
    expect(shape({ workspaces: { '.': {}, 'packages/plugins/*': {}, 'packages/typo': {} } })).toEqual([
      {
        check: 'pending-tags',
        where: 'knip.json workspaces["packages/typo"]',
        message: 'matches no workspace package (a typo, or a key left behind); fix or delete it',
      },
    ]);
  });
});

describe('pending-tags: check.run over a fixture workspace', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  const write = (root: string, path: string, content: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const workspace = (over: { vaultSource?: string; knip?: unknown; extra?: Record<string, string> } = {}): string => {
    const root = mkdtempSync(join(tmpdir(), 'pending-tags-'));
    roots.push(root);
    write(root, 'package.json', JSON.stringify({ name: 'root', workspaces: ['packages/*', 'packages/plugins/*'] }));
    write(
      root,
      'packages/plugins/vault/package.json',
      JSON.stringify({ name: '@ferretry/plugin-vault', ferretry: { id: 'vault', manifest: './manifest.ts' } }),
    );
    write(root, 'packages/plugins/vault/manifest.ts', "export default { id: 'vault', surfaces: ['secrets-tab'] };\n");
    write(
      root,
      'packages/plugins/vault/app/x.ts',
      over.vaultSource ?? '/** @pending vault: no event route yet */\nexport const a = 1;\n',
    );
    write(root, 'packages/app/package.json', JSON.stringify({ name: '@ferretry/app' }));
    write(
      root,
      'packages/app/src/x.ts',
      '/** @public A number kept with the protocol (§5.2). */\nexport const b = 1;\n',
    );
    write(
      root,
      'ports-pending.json',
      JSON.stringify({ format: 1, pending: ['vault'], pendingReasons: { vault: ['GAP(kernel): no event route yet'] } }),
    );
    write(
      root,
      'docs/rebuild/guarantees.tsv',
      'id\tstatus\towner\twith\tenforcer\tdoc\ttest\nS68\tkept\tvault\t-\tx\tdoc\tS68\n',
    );
    const knip = over.knip ?? { workspaces: { '.': {}, 'packages/plugins/*': {}, 'packages/app': {} } };
    write(root, 'knip.json', JSON.stringify(knip));
    write(root, 'knip.production.json', JSON.stringify(knip));
    for (const [path, content] of Object.entries(over.extra ?? {})) write(root, path, content);
    return root;
  };
  const messages = async (root: string): Promise<string[]> =>
    (await checkWith(new Map()).run(contextFor(root))).map(f => `${f.where}: ${f.message}`);

  test('a clean workspace is quiet', async () => {
    expect(await messages(workspace())).toEqual([]);
  });

  test('a tag a quote would have hidden from the old reader is found through the real wiring', async () => {
    const root = workspace({ vaultSource: 'export const a = 1;\n' });
    write(
      root,
      'packages/plugins/vault/app/y.tsx',
      "const a = <p>Don't</p>;\n/** @pending vault: totally bogus gap */\nexport const b = 1;\nconst c = <p>it's</p>;\n",
    );
    expect(await messages(root)).toEqual([
      'packages/plugins/vault/app/y.tsx:2: @pending gap "totally bogus gap" is in none of pendingReasons.vault in ports-pending.json',
    ]);
  });

  test('a glob-key ignore, an extra knip key and a stale key are found through the real wiring', async () => {
    const root = workspace({
      knip: {
        workspaces: {
          '.': {},
          'packages/plugins/*': { ignore: ['app/skeleton.ts'], ignoreFiles: ['app/y.ts'] },
          'packages/app': {},
          'packages/gone': {},
        },
      },
    });
    const found = await messages(root);
    expect(found).toContain(
      'knip.json workspaces["packages/plugins/*"].ignore: "app/skeleton.ts" is ignored, but no pendingReasons.vault line in ports-pending.json names it',
    );
    expect(found.some(m => m.includes('"ignoreFiles":app/y.ts'))).toBe(true);
    expect(found.some(m => m.includes('workspaces["packages/gone"]: matches no workspace package'))).toBe(true);
  });

  test('a stub @public in the app shell is a finding through the real wiring', async () => {
    const root = workspace({ extra: { 'packages/app/src/x.ts': '/** @public because */\nexport const b = 1;\n' } });
    expect(await messages(root)).toEqual([
      'packages/app/src/x.ts:1: @public needs a reason: a kept guarantee row id of this package, a § section ref, or a docs/… path that exists',
    ]);
  });

  test('a file that does not parse is a finding through the real wiring', async () => {
    const root = workspace({ extra: { 'packages/plugins/vault/app/x.ts': 'export const = ; // @pending\n' } });
    expect(await messages(root)).toEqual([expect.stringContaining('packages/plugins/vault/app/x.ts: does not parse')]);
  });
});
