import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Fixture, fixture, LEAF } from '../gen/tests/fixture.ts';
import {
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
        'tests/unit/x.test.ts':
          "import '../../../declared/contract/index.ts';\nimport '../../../../plugins/declared/contract/index.ts';\n",
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
