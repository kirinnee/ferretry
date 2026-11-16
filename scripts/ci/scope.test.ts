import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Fixture, fixture, LEAF } from '../gen/tests/fixture.ts';
import {
  checkDeclarations,
  type Decision,
  changedFiles,
  decide,
  describe as describeScope,
  filterFiles,
  FULL_LABEL,
  isSkippedFile,
  type PackageNode,
  readGraph,
  type ScopeInput,
  SCOPED_BASE_REF,
  selectScope,
} from './scope.ts';

// A small workspace: plugin b uses a, c uses b, d and e stand alone; hub is a plugin the app depends on.
const plugin = (id: string): PackageNode => ({ name: `@ferretry/plugin-${id}`, rel: `packages/plugins/${id}` });
const PLUGINS = ['a', 'b', 'c', 'd', 'e', 'hub'].map(plugin);
const PLATFORM: PackageNode[] = [
  { name: '@ferretry/kernel', rel: 'packages/core/kernel' },
  { name: '@ferretry/app', rel: 'packages/app' },
  { name: '@ferretry/std', rel: 'packages/std' },
  { name: 'fy', rel: 'packages/cli' },
];
const name = (id: string) => `@ferretry/plugin-${id}`;
const graph = (edges: Record<string, string[]>): Map<string, Set<string>> =>
  new Map([...PLUGINS, ...PLATFORM].map(pkg => [pkg.name, new Set(edges[pkg.name] ?? [])] as const));
const DEPENDS = graph({
  [name('b')]: [name('a')],
  [name('c')]: [name('b')],
  [name('a')]: ['@ferretry/kernel'],
  '@ferretry/app': [name('hub')],
});

const input = (changed: string[] | undefined, over: Partial<ScopeInput> = {}): ScopeInput => ({
  event: 'pull_request',
  baseRef: SCOPED_BASE_REF,
  labels: [],
  changed,
  packages: [...PLATFORM, ...PLUGINS],
  dependsOn: DEPENDS,
  ...over,
});
const full = (decision: Decision): string => {
  if (decision.mode !== 'full')
    throw new Error(`expected FULL, got SCOPED (${decision.selected.map(s => s.name).join(', ')})`);
  return decision.reason;
};
const scoped = (decision: Decision) => {
  if (decision.mode !== 'scoped') throw new Error(`expected SCOPED, got FULL (${decision.reason})`);
  return decision;
};
const ran = (decision: Decision): string[] =>
  scoped(decision).selected.map(pkg => pkg.name.replace('@ferretry/plugin-', ''));

test('a change only under one plugin selects that plugin and nothing else', () => {
  const decision = scoped(
    selectScope(input(['packages/plugins/d/daemon/lib/x.ts', 'packages/plugins/d/tests/unit/x.test.ts'])),
  );
  expect(ran(decision)).toEqual(['d']);
  expect(decision.selected[0]?.why).toBe('changed');
  expect(decision.skipped.map(pkg => pkg.rel)).toEqual(['a', 'b', 'c', 'e', 'hub'].map(id => `packages/plugins/${id}`));
  expect(decision.platform.map(pkg => pkg.name).sort()).toEqual(PLATFORM.map(pkg => pkg.name).sort());
});

test('a plugin that uses a changed plugin is selected, and so is the one that uses that one, with the reason', () => {
  const decision = scoped(selectScope(input(['packages/plugins/a/contract/index.ts'])));
  expect(ran(decision)).toEqual(['a', 'b', 'c']);
  expect(
    Object.fromEntries(decision.selected.map(pkg => [pkg.name.replace('@ferretry/plugin-', ''), pkg.why])),
  ).toEqual({
    a: 'changed',
    b: `depends on ${name('a')}`,
    c: `depends on ${name('b')}`,
  });
  // The other way round: changing the dependent selects only it, never what it depends on.
  expect(ran(selectScope(input(['packages/plugins/c/app/x.ts'])))).toEqual(['c']);
});

test('several changed plugins are all selected, and a dependent of two is in once', () => {
  expect(
    ran(selectScope(input(['packages/plugins/a/x.ts', 'packages/plugins/d/x.ts', 'packages/plugins/b/x.ts']))),
  ).toEqual(['a', 'b', 'c', 'd']);
});

// Every path class that must be FULL, each alone. A path nobody listed is FULL by default: the allowlist is the only list.
const FULL_PATHS = [
  'packages/core/kernel/host/x.ts',
  'packages/core/ferrets/daemon/x.ts',
  'packages/app/src/x.tsx',
  'packages/app/package.json',
  'packages/cli/src/lib/x.ts',
  'packages/std/src/x.ts',
  'packages/kernel/x.ts',
  'packages/protocol/src/x.ts',
  'packages/daemon/src/x.ts',
  'packages/newthing/x.ts',
  'packages/core/kernel/src/generated/plugins.ts',
  'packages/plugins/d/package.json',
  'packages/plugins/zzz/x.ts',
  'packages/plugins/x.ts',
  'packages/plugins/d',
  'scripts/ci/quick.sh',
  'scripts/gen/check.ts',
  'nix/pre-commit.nix',
  'flake.nix',
  '.github/workflows/ci.yaml',
  '.github/actions/install-nix/action.yml',
  'package.json',
  'bun.lock',
  'tsconfig.json',
  'tsconfig.base.json',
  'bunfig.unit.toml',
  'bunfig.toml',
  'biome.json',
  'knip.json',
  'Taskfile.yaml',
  'generated/hooks.md',
  'generated/contract-hashes.json',
  'ports-pending.json',
  'config/test-groups.json',
  'docs/standards/ci-cd/index.md',
  'docs/rebuild/merge-bar.md',
  'README.md',
  'a-top-level-path-nobody-has-seen.txt',
  'weird/dir/file.ts',
];
for (const path of FULL_PATHS)
  test(`${path} makes the run FULL`, () => {
    expect(full(selectScope(input([path])))).toContain(path);
    // Even beside a perfectly scopable plugin change.
    expect(full(selectScope(input(['packages/plugins/d/x.ts', path])))).toContain(path);
  });

test('a path that could point out of its folder, or is not a plain path, is FULL', () => {
  for (const path of [
    'packages/plugins/d/../../core/kernel/x.ts',
    '/packages/plugins/d/x.ts',
    'packages/plugins/d//x.ts',
    'packages/plugins/d/./x.ts',
    'packages\\plugins\\d\\x.ts',
    '',
  ])
    expect(full(selectScope(input([path])))).toContain('not a plain repository path');
});

test('a rename counts on both sides: out of a plugin, into a plugin, and between plugins', () => {
  // git lists both paths with --no-renames; one of them is outside the plugins here.
  expect(full(selectScope(input(['packages/plugins/d/x.ts', 'scripts/ci/x.ts'])))).toContain('scripts/ci/x.ts');
  expect(full(selectScope(input(['docs/x.md', 'packages/plugins/d/x.md'])))).toContain('docs/x.md');
  // Between two plugins: both are changed, so both (and their dependents) run.
  expect(ran(selectScope(input(['packages/plugins/d/old.ts', 'packages/plugins/e/new.ts'])))).toEqual(['d', 'e']);
  expect(ran(selectScope(input(['packages/plugins/a/old.ts', 'packages/plugins/e/new.ts'])))).toEqual([
    'a',
    'b',
    'c',
    'e',
  ]);
});

test('a deleted file is a changed file of its plugin like any other', () => {
  // git diff lists a deleted path; the plugin that owned it is selected even though the file is gone.
  expect(ran(selectScope(input(['packages/plugins/e/daemon/lib/gone.ts'])))).toEqual(['e']);
});

test('only a pull request into rebuild/5.0-after without the full-ci label is ever scoped', () => {
  const one = ['packages/plugins/d/x.ts'];
  expect(full(selectScope(input(one, { event: 'push' })))).toContain('"push"');
  expect(full(selectScope(input(one, { event: 'workflow_dispatch' })))).toContain('"workflow_dispatch"');
  expect(full(selectScope(input(one, { event: undefined })))).toContain('not a CI event');
  expect(full(selectScope(input(one, { baseRef: 'rebuild/5.0' })))).toContain('"rebuild/5.0"');
  expect(full(selectScope(input(one, { baseRef: 'main' })))).toContain('"main"');
  expect(full(selectScope(input(one, { baseRef: 'rebuild/5.0-after-2' })))).toContain('only rebuild/5.0-after');
  expect(full(selectScope(input(one, { baseRef: 'refs/heads/rebuild/5.0-after' })))).toContain(
    'only rebuild/5.0-after',
  );
  expect(full(selectScope(input(one, { baseRef: undefined })))).toContain('unknown');
  expect(full(selectScope(input(one, { labels: ['bug', FULL_LABEL] })))).toContain(FULL_LABEL);
  expect(ran(selectScope(input(one, { labels: ['bug', 'full-ci-not'] })))).toEqual(['d']);
});

test('a missing merge-base (changed files unknown) and an empty diff are FULL', () => {
  expect(full(selectScope(input(undefined, { changedError: 'no merge-base' })))).toContain('no merge-base');
  expect(full(selectScope(input(undefined)))).toContain('could not be computed');
  expect(full(selectScope(input([])))).toContain('empty');
});

test('a plugin a platform package depends on is a hub: changing it, or something that reaches it, is FULL', () => {
  expect(full(selectScope(input(['packages/plugins/hub/x.ts'])))).toContain('platform package @ferretry/app');
  // d is not a hub, but if e depends on hub, changing hub selects e AND is itself a hub; the reverse is not:
  const reaching = graph({ [name('hub')]: [name('d')], '@ferretry/app': [name('hub')] });
  // d changed -> hub selected (depends on d) -> the app depends on hub -> FULL.
  expect(full(selectScope(input(['packages/plugins/d/x.ts'], { dependsOn: reaching })))).toContain('depends on');
  // A platform package depending on an UNselected plugin changes nothing.
  expect(ran(selectScope(input(['packages/plugins/e/x.ts'], { dependsOn: reaching })))).toEqual(['e']);
});

test('platform packages never carry the closure: kernel depended on by every plugin does not select them all', () => {
  const everyone = graph(Object.fromEntries(PLUGINS.map(pkg => [pkg.name, ['@ferretry/kernel', '@ferretry/app']])));
  expect(ran(selectScope(input(['packages/plugins/d/x.ts'], { dependsOn: everyone })))).toEqual(['d']);
});

test('selecting every plugin leaves nothing to skip, which is FULL and says so', () => {
  const all = graph(
    Object.fromEntries(PLUGINS.filter(pkg => pkg.name !== name('a')).map(pkg => [pkg.name, [name('a')]])),
  );
  expect(
    full(
      selectScope(
        input(['packages/plugins/a/x.ts'], {
          dependsOn: all,
          packages: [...PLATFORM, ...PLUGINS.filter(pkg => pkg.name !== name('hub'))],
        }),
      ),
    ),
  ).toContain('nothing could be skipped');
});

test('a plugin cycle selects each member once', () => {
  const cycle = graph({ [name('a')]: [name('b')], [name('b')]: [name('a')] });
  expect(ran(selectScope(input(['packages/plugins/a/x.ts'], { dependsOn: cycle })))).toEqual(['a', 'b']);
});

test('the test files of skipped plugins are dropped, prefix lookalikes and platform tests are kept', () => {
  const skipped = [{ rel: 'packages/plugins/d' }];
  expect(isSkippedFile('./packages/plugins/d/tests/unit/x.test.ts', skipped)).toBe(true);
  expect(isSkippedFile('packages/plugins/d/tests/unit/x.test.ts', skipped)).toBe(true);
  expect(isSkippedFile('./packages/plugins/dd/tests/unit/x.test.ts', skipped)).toBe(false);
  expect(isSkippedFile('./packages/core/kernel/tests/unit/x.test.ts', skipped)).toBe(false);
  expect(isSkippedFile('./packages/app/tests/unit/plugins/d/x.test.ts', skipped)).toBe(false);
  const files = [
    './packages/plugins/d/tests/unit/x.test.ts',
    './packages/plugins/a/tests/unit/x.test.ts',
    './packages/core/kernel/tests/unit/x.test.ts',
  ];
  expect(filterFiles(selectScope(input(['packages/plugins/a/x.ts'])), files)).toEqual(files.slice(1));
  // A FULL decision keeps every file.
  expect(filterFiles(selectScope(input(['scripts/x.sh'])), files)).toEqual(files);
});

test('a scoped run never prints the sentence a full run prints, and names every plugin it runs or skips', () => {
  const decision = selectScope(input(['packages/plugins/a/x.ts']));
  const lines = describeScope(decision, 6).join('\n');
  expect(lines).toStartWith('CI scope: SCOPED - 3 of 6 plugins run, 3 skipped');
  expect(lines).toContain('NOT the full unit set and NOT the complete production ledger');
  expect(lines).toContain('run  packages/plugins/b (depends on @ferretry/plugin-a)');
  expect(lines).toContain('skip packages/plugins/d');
  expect(lines).not.toContain('FULL');
  const fullLine = describeScope(selectScope(input(['scripts/x.sh'])), 6).join('\n');
  expect(fullLine).toStartWith('CI scope: FULL - scripts/x.sh is outside the plugin packages');
  expect(fullLine).toContain('Every unit test runs.');
  expect(fullLine).not.toContain('SCOPED');
});

// ─── git: the changed set from a real repository ────────────────────────────────────────────────────────────────

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]): string => {
  const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
};
const repo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-'));
  sandboxes.push(dir);
  git(dir, 'init', '--quiet', '--initial-branch=main');
  return dir;
};
const put = (dir: string, path: string, text: string): void => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};
const commit = (dir: string, message: string): string => {
  git(dir, 'add', '--all');
  git(dir, 'commit', '--quiet', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
};

test('the changed set is the diff against the MERGE-BASE, with both sides of a rename and a deletion', () => {
  const dir = repo();
  put(dir, 'packages/plugins/a/old.ts', 'export const a = 1;\n');
  put(dir, 'packages/plugins/a/gone.ts', 'export const gone = 1;\n');
  put(dir, 'packages/plugins/b/keep.ts', 'export const b = 1;\n');
  const fork = commit(dir, 'base');
  git(dir, 'checkout', '--quiet', '-b', 'feature');
  mkdirSync(join(dir, 'packages/plugins/e'), { recursive: true });
  git(dir, 'mv', 'packages/plugins/a/old.ts', 'packages/plugins/e/new.ts');
  git(dir, 'rm', '--quiet', 'packages/plugins/a/gone.ts');
  put(dir, 'packages/plugins/d/added.ts', 'export const d = 1;\n');
  const head = commit(dir, 'feature');
  // The base moved on after the fork: its own new file must NOT be a change of this pull request.
  git(dir, 'checkout', '--quiet', 'main');
  put(dir, 'scripts/base-only.sh', '#!/bin/sh\n');
  const base = commit(dir, 'base moved');
  const result = changedFiles(dir, base, head);
  expect('files' in result && result.files.sort()).toEqual([
    'packages/plugins/a/gone.ts',
    'packages/plugins/a/old.ts',
    'packages/plugins/d/added.ts',
    'packages/plugins/e/new.ts',
  ]);
  expect(git(dir, 'merge-base', base, head)).toBe(fork);
});

test('no merge-base, or a missing sha, is an error the decision turns into FULL', () => {
  const dir = repo();
  put(dir, 'a.txt', 'a');
  const first = commit(dir, 'first');
  git(dir, 'checkout', '--quiet', '--orphan', 'unrelated');
  put(dir, 'b.txt', 'b');
  const second = commit(dir, 'unrelated root');
  expect(changedFiles(dir, first, second)).toEqual({ error: expect.stringContaining('no merge-base') });
  expect(changedFiles(dir, '', second)).toEqual({ error: 'the base or head sha is missing' });
  expect(changedFiles(dir, first, 'not-a-sha')).toEqual({ error: 'the base or head sha is missing' });
  expect(changedFiles(dir, 'a'.repeat(40), second)).toEqual({ error: expect.stringContaining('no merge-base') });
});

// ─── the dependency graph of a real workspace ───────────────────────────────────────────────────────────────────

const fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
});
const PORT = (id: string): string =>
  `import { definePort } from '${LEAF}';\nexport const ${id}Port = definePort<{ ping(): void }>('${id}');\n`;

test('the graph is the UNION of package.json, the manifests (needs/uses) and source mentions', async () => {
  const fx = fixture([
    // `uses` only (no package.json dependency, no import of the package by name).
    {
      id: 'user',
      manifestImports: "import { ownerPort } from '../owner/contract/index.ts';",
      manifest: '  uses: { owner: ownerPort },',
    },
    {
      id: 'owner',
      contract: PORT('owner'),
      manifestImports: "import { ownerPort } from './contract/index.ts';",
      manifest: '  provides: { owner: ownerPort },',
    },
    // package.json dependency only.
    { id: 'declared' },
    { id: 'target' },
    // A mention in a source file only.
    { id: 'mentions', files: { 'daemon/lib/x.ts': "import '@ferretry/plugin-target/contract';\n" } },
    // A relative path into another plugin, in a test.
    {
      id: 'relative',
      files: {
        'tests/unit/x.test.ts': "import '../../../declared/contract/index.ts';\n",
      },
    },
    { id: 'alone' },
  ]);
  fixtures.push(fx);
  const pkgPath = join(fx.root, 'packages/plugins/declared/package.json');
  const json = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(pkgPath, JSON.stringify({ ...json, devDependencies: { '@ferretry/plugin-target': 'workspace:*' } }));
  // A generated registry names everyone and must be ignored.
  fx.write('packages/plugins/alone/src/generated/all.ts', "import '@ferretry/plugin-target/contract';\n");
  const result = await readGraph(fx.root);
  const edges = (id: string): string[] => [...(result.dependsOn.get(`@ferretry/plugin-${id}`) ?? [])].sort();
  expect(edges('user')).toEqual(['@ferretry/plugin-owner']);
  expect(edges('declared')).toEqual(['@ferretry/plugin-target']);
  expect(edges('mentions')).toEqual(['@ferretry/plugin-target']);
  expect(edges('relative')).toEqual(['@ferretry/plugin-declared']);
  expect(edges('alone')).toEqual([]);
  expect(result.packages.map(pkg => pkg.rel)).toContain('packages/plugins/user');
  // And the decision over that graph: changing the provider selects its user.
  const decision = selectScope({
    event: 'pull_request',
    baseRef: SCOPED_BASE_REF,
    labels: [],
    changed: ['packages/plugins/owner/contract/x.ts'],
    packages: result.packages,
    dependsOn: result.dependsOn,
  });
  expect(ran(decision)).toEqual(['owner', 'user']);
});

test('a manifest that fails to load fails the graph, and the decision falls back to FULL', async () => {
  const fx = fixture([
    { id: 'broken', manifest: "  needs: { x: (() => { throw new Error('boom'); })() }," },
    { id: 'fine' },
  ]);
  fixtures.push(fx);
  await expect(readGraph(fx.root)).rejects.toThrow('manifests did not load');
  const out = join(fx.root, 'scope.json');
  const decision = await decide(
    fx.root,
    {
      FY_SCOPE_EVENT: 'pull_request',
      FY_SCOPE_BASE_REF: SCOPED_BASE_REF,
      FY_SCOPE_LABELS: '[]',
      FY_SCOPE_BASE_SHA: 'a'.repeat(40),
      FY_SCOPE_HEAD_SHA: 'b'.repeat(40),
      GITHUB_STEP_SUMMARY: join(fx.root, 'summary.md'),
    },
    out,
  );
  expect(full(decision)).toContain('could not be computed');
  expect(JSON.parse(readFileSync(out, 'utf8')).mode).toBe('full');
  expect(readFileSync(join(fx.root, 'summary.md'), 'utf8')).toContain('CI scope: FULL');
});

test('decide reads the CI environment: a push, a dispatch, a label list that is not JSON are all FULL and write the decision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-decide-'));
  sandboxes.push(dir);
  const run = async (env: Record<string, string>) =>
    decide(dir, { GITHUB_STEP_SUMMARY: join(dir, 'summary.md'), ...env }, join(dir, 'scope.json'));
  expect(full(await run({ FY_SCOPE_EVENT: 'push', FY_SCOPE_BASE_REF: SCOPED_BASE_REF }))).toContain('"push"');
  expect(full(await run({}))).toContain('not a CI event');
  expect(
    full(await run({ FY_SCOPE_EVENT: 'pull_request', FY_SCOPE_BASE_REF: 'main', FY_SCOPE_LABELS: '[]' })),
  ).toContain('"main"');
  expect(
    full(
      await run({ FY_SCOPE_EVENT: 'pull_request', FY_SCOPE_BASE_REF: SCOPED_BASE_REF, FY_SCOPE_LABELS: '["full-ci"]' }),
    ),
  ).toContain(FULL_LABEL);
  expect(
    full(
      await run({ FY_SCOPE_EVENT: 'pull_request', FY_SCOPE_BASE_REF: SCOPED_BASE_REF, FY_SCOPE_LABELS: 'not json' }),
    ),
  ).toContain('could not be computed');
  expect(
    full(await run({ FY_SCOPE_EVENT: 'pull_request', FY_SCOPE_BASE_REF: SCOPED_BASE_REF, FY_SCOPE_LABELS: '{"a":1}' })),
  ).toContain('could not be computed');
  // A pull request with no shas reads the repository and finds nothing to diff.
  expect(
    full(await run({ FY_SCOPE_EVENT: 'pull_request', FY_SCOPE_BASE_REF: SCOPED_BASE_REF, FY_SCOPE_LABELS: 'null' })),
  ).toContain('could not be computed');
  expect(JSON.parse(readFileSync(join(dir, 'scope.json'), 'utf8')).mode).toBe('full');
});

// ─── the REAL imports: a relative path into a sibling plugin is an edge ─────────────────────────────────────────

const edgesOf = (graph: Awaited<ReturnType<typeof readGraph>>, id: string): string[] =>
  [...(graph.dependsOn.get(`@ferretry/plugin-${id}`) ?? [])].sort();
const choose = (graph: Awaited<ReturnType<typeof readGraph>>, changed: string[]): Decision =>
  selectScope({ event: 'pull_request', baseRef: SCOPED_BASE_REF, labels: [], changed, ...graph });

test('a relative import of a sibling plugin is an edge in every place a file can import from, with no other mention', async () => {
  const fx = fixture([
    { id: 'owner' },
    // Each dependent holds the sibling ONLY as a relative path: no `@ferretry/` name, no `plugins/` segment.
    { id: 'via-test', files: { 'tests/unit/x.test.ts': "import '../../../owner/contract/index.ts';\n" } },
    {
      id: 'via-support',
      files: {
        'tests/support/helper.ts': "import { x } from '../../../owner/contract/index.ts';\nexport const y = x;\n",
      },
    },
    { id: 'via-reexport', files: { 'src/index.ts': "export * from '../../owner/contract/index.ts';\n" } },
    { id: 'via-named-reexport', files: { 'app/index.ts': "export { x } from '../../owner/contract/index.ts';\n" } },
    {
      id: 'via-dynamic',
      files: { 'cli/lazy.ts': "export const load = () => import('../../owner/contract/index.ts');\n" },
    },
    {
      id: 'via-template',
      files: { 'daemon/lazy.ts': 'export const load = (n: string) => import(`../../owner/daemon/${n}.ts`);\n' },
    },
    {
      id: 'via-type-only',
      files: { 'daemon/types.ts': "import type { T } from '../../owner/contract/index.ts';\nexport type U = T;\n" },
    },
    { id: 'via-css', files: { 'app/styles.css': "@import '../../owner/app/styles.css';\n" } },
    // None of these reaches the owner.
    {
      id: 'own-template',
      files: { 'app/index.ts': 'export const view = (n: string) => import(`./views/${n}.tsx`);\n' },
    },
    { id: 'alone' },
  ]);
  fixtures.push(fx);
  const result = await readGraph(fx.root);
  for (const id of [
    'via-test',
    'via-support',
    'via-reexport',
    'via-named-reexport',
    'via-dynamic',
    'via-template',
    'via-type-only',
    'via-css',
  ])
    expect(edgesOf(result, id)).toEqual(['@ferretry/plugin-owner']);
  expect(edgesOf(result, 'own-template')).toEqual([]);
  expect(edgesOf(result, 'alone')).toEqual([]);
  expect(ran(choose(result, ['packages/plugins/owner/contract/x.ts'])).sort()).toEqual(
    [
      'owner',
      'via-css',
      'via-dynamic',
      'via-named-reexport',
      'via-reexport',
      'via-support',
      'via-template',
      'via-test',
      'via-type-only',
    ].sort(),
  );
});

test('an import that lands in the repository but in no plugin package is no edge (a change there is FULL already)', async () => {
  const fx = fixture([
    {
      id: 'reads',
      files: {
        'tests/unit/a.test.ts':
          "import '../../../../../ports-pending.json';\nimport '../../../../../scripts/validate/x.ts';\n",
      },
    },
    { id: 'alone' },
  ]);
  fixtures.push(fx);
  const result = await readGraph(fx.root);
  expect(edgesOf(result, 'reads')).toEqual([]);
  expect(full(choose(result, ['scripts/validate/x.ts']))).toContain('outside the plugin packages');
});

test('a relative import that leaves the repository makes the graph fail, and the decision says which file and line', async () => {
  const fx = fixture([
    { id: 'escapes', files: { 'daemon/a.ts': "export const ok = 1;\nimport '../../../../../outside.ts';\n" } },
    { id: 'fine' },
  ]);
  fixtures.push(fx);
  await expect(readGraph(fx.root)).rejects.toThrow(
    'escapes/daemon/a.ts: line 2: "../../../../../outside.ts" leaves the repository',
  );
  const decision = await decide(
    fx.root,
    {
      FY_SCOPE_EVENT: 'pull_request',
      FY_SCOPE_BASE_REF: SCOPED_BASE_REF,
      FY_SCOPE_LABELS: '[]',
      FY_SCOPE_BASE_SHA: 'a'.repeat(40),
      FY_SCOPE_HEAD_SHA: 'b'.repeat(40),
      GITHUB_STEP_SUMMARY: join(fx.root, 'summary.md'),
    },
    join(fx.root, 'scope.json'),
  );
  expect(full(decision)).toContain('leaves the repository');
});

test('a file that does not parse makes the graph fail', async () => {
  const fx = fixture([{ id: 'broken', files: { 'daemon/a.ts': 'export const = ;\n' } }, { id: 'fine' }]);
  fixtures.push(fx);
  await expect(readGraph(fx.root)).rejects.toThrow('could not be parsed');
});

test('a computed dynamic import makes its package depend on everything, says why, and costs only that package', async () => {
  const fx = fixture([
    { id: 'owner' },
    { id: 'computed', files: { 'daemon/lazy.ts': 'export const load = (m: string) => import(m);\n' } },
    {
      id: 'multiline',
      files: { 'daemon/lazy.ts': 'export const load = (a: string) =>\n  import(\n    a + "x",\n  );\n' },
    },
    {
      id: 'marked',
      files: {
        'tests/unit/all.test.ts':
          'export const load = async (f: string) => {\n  // scope-deps: manifests\n  return import(f);\n};\n',
      },
    },
    {
      id: 'unmarked',
      files: {
        'tests/unit/all.test.ts':
          'export const load = async (f: string) => {\n  // scope-dependencies manifests\n  return import(f);\n};\n',
      },
    },
    { id: 'alone' },
  ]);
  fixtures.push(fx);
  const result = await readGraph(fx.root);
  expect(edgesOf(result, 'computed')).toContain('@ferretry/plugin-owner');
  expect(edgesOf(result, 'computed')).toContain('@ferretry/plugin-alone');
  expect(edgesOf(result, 'multiline')).toContain('@ferretry/plugin-owner');
  expect(edgesOf(result, 'unmarked')).toContain('@ferretry/plugin-owner');
  expect(edgesOf(result, 'marked')).toEqual([]);
  expect(result.opaque.get('@ferretry/plugin-computed')).toContain('daemon/lazy.ts: line 1');
  const decision = scoped(choose(result, ['packages/plugins/alone/daemon/x.ts']));
  expect(ran(decision).sort()).toEqual(['alone', 'computed', 'multiline', 'unmarked']);
  const line = describeScope(decision, 6).find(row => row.includes('run  packages/plugins/computed')) ?? '';
  expect(line).toContain('cannot resolve');
  expect(line).toContain('daemon/lazy.ts: line 1');
});

test('a computed dynamic import in a platform package makes every plugin a hub: FULL', async () => {
  const fx = fixture([
    { id: 'platform', core: true, files: { 'src/lazy.ts': 'export const load = (m: string) => import(m);\n' } },
    { id: 'a' },
    { id: 'b' },
  ]);
  fixtures.push(fx);
  const result = await readGraph(fx.root);
  expect(full(choose(result, ['packages/plugins/a/daemon/x.ts']))).toContain('depended on by the platform package');
});

test('a ports-pending record or a plugin manifest is never scopable, wherever it sits', () => {
  for (const path of [
    'ports-pending.json',
    'packages/plugins/a/ports-pending.json',
    'packages/plugins/a/daemon/ports-pending.json',
    'packages/plugins/a/ports-pending/b.json',
    'packages/plugins/a/ports-pending.yaml',
    'packages/core/kernel/ports-pending.json',
  ])
    expect(full(selectScope(input([path])))).toMatch(/ports-pending|outside the plugin packages/);
  expect(full(selectScope(input(['packages/plugins/a/ports-pending.json'])))).toContain('ports-pending record');
  expect(full(selectScope(input(['packages/plugins/a/manifest.ts'])))).toContain('plugin manifest');
  // Lookalikes are plain files of the plugin.
  expect(ran(selectScope(input(['packages/plugins/a/daemon/ports-pending-note.ts'])))).toContain('a');
});

// ─── the real workspace ─────────────────────────────────────────────────────────────────────────────────────────

const REPO = join(import.meta.dir, '..', '..');
const MCP_LIMITS = './packages/plugins/mcp/tests/unit/cli/tools-limits.test.ts';
const realGraph = readGraph(REPO);

test.each([
  ['Lessons', 'packages/plugins/lessons/contract/suggest.ts'],
  ['Accounts', 'packages/plugins/accounts/contract/routes/login-recipes.ts'],
])('the real workspace: a %s contract change keeps the MCP limits test that imports it', async (_, changed) => {
  const result = await realGraph;
  const decision = choose(result, [changed]);
  expect(filterFiles(decision, [MCP_LIMITS])).toEqual([MCP_LIMITS]);
  expect(ran(decision)).toContain('mcp');
});

// ─── tests that READ the source tree (scope-readers.ts): the graph sees imports only ────────────────────────────

const ONBOARDING_APP = 'packages/plugins/onboarding/app/index.ts';
const CONNECTIONS_MANIFEST = './packages/plugins/connections/tests/unit/manifest.test.ts';
const SHELLS_APP = 'packages/plugins/shells/app/index.ts';
const OPT_IN = './packages/plugins/conversation/tests/unit/app/render/fy-render-opt-in.test.ts';

test('the real workspace: an Onboarding app change keeps the Connections manifest test that reads every onboarding app file', async () => {
  const decision = choose(await realGraph, [ONBOARDING_APP]);
  expect(filterFiles(decision, [CONNECTIONS_MANIFEST])).toEqual([CONNECTIONS_MANIFEST]);
});

test('the real workspace: a Shells app change keeps the repository-wide executable-render opt-in guard', async () => {
  const decision = choose(await realGraph, [SHELLS_APP]);
  expect(filterFiles(decision, [OPT_IN])).toEqual([OPT_IN]);
});

test.each([
  'packages/plugins/accounts/tests/unit/daemon/sign-in-grants/vault-parity.test.ts',
  'packages/plugins/browsers/tests/unit/address-rule.test.ts',
  'packages/plugins/connections/tests/unit/worker/relay-config.test.ts',
  'packages/plugins/mcp/tests/unit/cli/serve-seams.test.ts',
  'packages/plugins/conversation/tests/unit/app/chat/chat-log-cell.test.ts',
  'packages/plugins/conversation/tests/unit/app/chat/chat-stylesheet.test.ts',
  'packages/plugins/terminals/tests/unit/app/terminal-font.test.ts',
  'packages/plugins/agenda/tests/unit/app/agenda-deck-fullscreen-css.test.ts',
])('the real workspace: %s reads the source tree and is detected as a reader', async file => {
  expect((await realGraphReaders).has(file)).toBe(true);
});
const realGraphReaders = realGraph.then(result => result.readers);

/** A plugin skeleton for the reader fixtures; each one gets a changed `app/index.ts` in the diff below. */
const readerFixture = (): { fx: Fixture; run: (changed: string) => Promise<Decision> } => {
  const fx = fixture([
    { id: 'ob', files: { 'app/index.ts': 'export const v = 1;\n' } },
    // Reads another plugin's app source by path, with no import: Connections → Onboarding.
    {
      id: 'conn',
      files: {
        'tests/unit/manifest.test.ts':
          "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst dir = join(import.meta.dir, '../../../ob/app');\nreadFileSync(join(dir, 'index.ts'), 'utf8');\n",
      },
    },
    // A glob scan of every plugin's app: Conversation → everything.
    {
      id: 'scan',
      files: {
        'tests/unit/opt-in.test.ts':
          "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nfor (const f of new Bun.Glob('*/app/**/*.ts').scanSync({ cwd: join(import.meta.dir, '../../..') })) readFileSync(f, 'utf8');\n",
      },
    },
    // The read is in a helper; the test itself calls no read API.
    {
      id: 'helped',
      files: {
        'tests/support/read-app.ts':
          "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nexport const app = (): string => readFileSync(join(import.meta.dir, '../../../ob/app/index.ts'), 'utf8');\n",
        'tests/unit/helped.test.ts': "import { app } from '../support/read-app.ts';\napp();\n",
      },
    },
    // Reads only a temp folder it made: a pure test, skipped with its plugin.
    {
      id: 'pure',
      files: {
        'tests/unit/pure.test.ts':
          "import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nconst dir = mkdtempSync(join(tmpdir(), 'x-'));\nwriteFileSync(join(dir, 'a'), 'a');\nreadFileSync(join(dir, 'a'), 'utf8');\n",
      },
    },
    { id: 'other', files: { 'tests/unit/other.test.ts': "import { expect } from 'bun:test';\nexpect(1).toBe(1);\n" } },
  ]);
  fixtures.push(fx);
  git(fx.root, 'init', '--quiet', '--initial-branch=main');
  const base = commit(fx.root, 'base');
  return {
    fx,
    run: async changed => {
      fx.write(changed, `// changed ${Math.random()}\n`);
      const head = commit(fx.root, 'change');
      return decide(
        fx.root,
        {
          FY_SCOPE_EVENT: 'pull_request',
          FY_SCOPE_BASE_REF: SCOPED_BASE_REF,
          FY_SCOPE_LABELS: '[]',
          FY_SCOPE_BASE_SHA: base,
          FY_SCOPE_HEAD_SHA: head,
          GITHUB_STEP_SUMMARY: join(fx.root, 'summary.md'),
        },
        join(fx.root, 'scope.json'),
      );
    },
  };
};

test('changedFiles + decide: a test that reads source by path, directly, by glob or through a helper, is kept inside a skipped plugin; a temp-only test is not', async () => {
  const { run } = readerFixture();
  const decision = scoped(await run('packages/plugins/other/daemon/x.ts'));
  expect(decision.skipped.map(pkg => pkg.rel.split('/').pop()).sort()).toEqual([
    'conn',
    'helped',
    'ob',
    'pure',
    'scan',
  ]);
  expect(decision.alwaysRun.map(test => test.file)).toEqual([
    'packages/plugins/conn/tests/unit/manifest.test.ts',
    'packages/plugins/helped/tests/unit/helped.test.ts',
    'packages/plugins/scan/tests/unit/opt-in.test.ts',
  ]);
  const files = [
    './packages/plugins/conn/tests/unit/manifest.test.ts',
    './packages/plugins/scan/tests/unit/opt-in.test.ts',
    './packages/plugins/helped/tests/unit/helped.test.ts',
    './packages/plugins/pure/tests/unit/pure.test.ts',
    './packages/plugins/ob/app/x.test.ts',
    './packages/plugins/other/tests/unit/other.test.ts',
  ];
  expect(filterFiles(decision, files)).toEqual([...files.slice(0, 3), files[5] as string]);
  // The log says which ones and why.
  expect(describeScope(decision, 6).join('\n')).toContain('keep packages/plugins/conn/tests/unit/manifest.test.ts');
});

test('a declared bounded reader runs only when its input changes; `all` always runs; `self` adds nothing', async () => {
  const { fx } = readerFixture();
  const declare = (id: string, line: string): void => {
    const file = `packages/plugins/${id}/tests/unit/${id === 'conn' ? 'manifest' : 'opt-in'}.test.ts`;
    fx.write(file, `${line}\n${readFileSync(join(fx.root, file), 'utf8')}`);
  };
  declare('conn', '// scope-deps: packages/plugins/ob/app');
  declare('scan', '// scope-deps: all');
  const graph = await readGraph(fx.root);
  expect(edgesOf(graph, 'conn')).toEqual(['@ferretry/plugin-ob']);
  expect([...graph.readers.keys()]).toContain('packages/plugins/scan/tests/unit/opt-in.test.ts');
  expect([...graph.readers.keys()]).not.toContain('packages/plugins/conn/tests/unit/manifest.test.ts');
  // The input changes: the declaring test's plugin is selected, with the reason.
  const byInput = scoped(choose(graph, ['packages/plugins/ob/app/index.ts']));
  expect(ran(byInput).sort()).toEqual(['conn', 'ob']);
  // Something else changes: the bounded reader is skipped, the `all` reader is kept.
  const other = scoped(choose(graph, ['packages/plugins/other/daemon/x.ts']));
  expect(
    filterFiles(other, [
      './packages/plugins/conn/tests/unit/manifest.test.ts',
      './packages/plugins/scan/tests/unit/opt-in.test.ts',
    ]),
  ).toEqual(['./packages/plugins/scan/tests/unit/opt-in.test.ts']);
  // `self` is a claim about the own package: no edge, not kept.
  declare('conn', '// scope-deps: self');
  const self = await readGraph(fx.root);
  expect([...self.readers.keys()]).not.toContain('packages/plugins/conn/tests/unit/manifest.test.ts');
});

test('a declaration that names nothing that exists is a failure of the gate, of the graph, and of `scope.ts check`', async () => {
  const { fx } = readerFixture();
  const file = 'packages/plugins/conn/tests/unit/manifest.test.ts';
  const body = readFileSync(join(fx.root, file), 'utf8');
  for (const line of [
    '// scope-deps: packages/plugins/ob/app/missing',
    '// scope-deps: packages/plugins/*/nothing/**',
    '// scope-deps: @ferretry/plugin-missing',
    '// scope-deps: ../outside',
  ]) {
    fx.write(file, `${line}\n${body}`);
    expect(await checkDeclarations(fx.root)).toEqual([expect.stringContaining(file)]);
    await expect(readGraph(fx.root)).rejects.toThrow('scope-deps declarations are wrong');
    const run = spawnSync(process.execPath, [join(REPO, 'scripts/ci/scope.ts'), 'check'], {
      cwd: fx.root,
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(file);
  }
  // A good one passes the gate; the manifests marker above a computed import is not a declaration.
  fx.write(file, `// scope-deps: manifests\n// scope-deps: packages/plugins/ob/app, self\n${body}`);
  expect(await checkDeclarations(fx.root)).toEqual([]);
});

test('the real repository passes the declaration gate', async () => {
  expect(await checkDeclarations(REPO)).toEqual([]);
});
