import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, evaluate, homeLine, outsideEntries, packageOf, packageRoots, run } from './one-folder.ts';

const ROOTS = [
  'packages/plugins/board',
  'packages/plugins/agenda',
  'packages/core/kernel',
  'packages/app',
  'packages/cli',
];

const body = (...lines: string[]): string => ['Some summary.', '', ...lines].join('\n');
const check = (changed: string[], text: string, lines?: Map<string, number>) =>
  evaluate({
    changed,
    roots: ROOTS,
    body: text,
    lines: lines ?? new Map(changed.map((file, index) => [file, index === 0 ? 10 : 1] as const)),
  });

test('only files in the home package: passes with no body at all', () => {
  const result = check(['packages/plugins/board/daemon/index.ts', 'packages/plugins/board/package.json'], '');
  expect(result.ok).toBe(true);
  expect(result.home).toEqual(['packages/plugins/board']);
  expect(result.homeFrom).toBe('changed-lines');
  expect(result.outside).toEqual([]);
});

test('an outside file with no reason fails and names the file', () => {
  const result = check(['packages/plugins/board/a.ts', 'packages/core/kernel/src/x.ts'], body('## Outside files', ''));
  expect(result.ok).toBe(false);
  expect(result.missing).toEqual(['packages/core/kernel/src/x.ts']);
  expect(result.hasSection).toBe(true);
  const text = describe(result).join('\n');
  expect(text).toContain('✗ packages/core/kernel/src/x.ts');
  expect(text).toContain('## Outside files');
});

test('an entry with a path but no reason does not count, and is said', () => {
  const result = check(
    ['packages/plugins/board/a.ts', 'knip.json'],
    body('## Outside files', '- `knip.json`', '- knip.json:'),
  );
  expect(result.ok).toBe(false);
  expect(result.missing).toEqual(['knip.json']);
  expect(result.badEntries.join('\n')).toContain('has no reason');
});

test('an outside file with a reason passes, in every spelling of an entry', () => {
  for (const entry of [
    '- knip.json: the new plugin has an entry',
    '- `knip.json`: the new plugin has an entry',
    '- `knip.json` - the new plugin has an entry',
    '* knip.json — the new plugin has an entry',
    '1. knip.json: the new plugin has an entry',
    '- `knip.json`, `nix/x.nix`: both list the new plugin',
  ]) {
    const result = check(['packages/plugins/board/a.ts', 'knip.json'], body('## Outside files', entry));
    expect(result.ok).toBe(true);
    expect(result.explained).toEqual([{ file: 'knip.json', pattern: 'knip.json' }]);
  }
});

test('a glob or a folder entry with a reason covers every file it matches', () => {
  const changed = [
    'packages/plugins/board/a.ts',
    'scripts/ci/one-folder.ts',
    'scripts/ci/one-folder.test.ts',
    'docs/x.md',
  ];
  const result = check(
    changed,
    body('## Outside files', '- scripts/ci/*.ts: the rule lives here', '- `docs/`: the doctrine'),
  );
  expect(result.ok).toBe(true);
  expect(result.explained.map(entry => entry.pattern)).toEqual(['scripts/ci/*.ts', 'scripts/ci/*.ts', 'docs/']);
  // a glob does not reach into a sibling folder
  expect(
    check(['packages/plugins/board/a.ts', 'scripts/gen/x.ts'], body('## Outside files', '- scripts/ci/*.ts: here')).ok,
  ).toBe(false);
});

test('a glob that would cover the whole repository explains nothing', () => {
  for (const pattern of ['**', '*', '**/*.ts', '*.ts']) {
    const result = check(
      ['packages/plugins/board/a.ts', 'knip.json', 'x.ts'],
      body('## Outside files', `- ${pattern}: everything`),
    );
    expect(result.ok).toBe(false);
    expect(result.badEntries.join('\n')).toContain('too broad');
  }
});

test('the lockfile never needs a reason; the nix pins only when a package.json or the lockfile changed', () => {
  const home = 'packages/plugins/board/package.json';
  expect(check([home, 'bun.lock'], '').ok).toBe(true);
  const withDeps = check([home, 'bun.lock', 'nix/ferretry.nix', 'nix/bun-deps.inputs'], '');
  expect(withDeps.ok).toBe(true);
  expect(withDeps.allowed).toEqual(['bun.lock', 'nix/ferretry.nix', 'nix/bun-deps.inputs']);
  // the same nix edit with no dependency change is an ordinary outside file
  const alone = check(['packages/plugins/board/a.ts', 'nix/ferretry.nix'], '');
  expect(alone.ok).toBe(false);
  expect(alone.missing).toEqual(['nix/ferretry.nix']);
  // generated registries
  expect(
    check(['packages/plugins/board/a.ts', 'packages/app/src/generated/surfaces.ts', 'generated/hooks.md'], '').ok,
  ).toBe(true);
});

test('the home is the package with the most changed lines, not the most files; a tie keeps both', () => {
  const changed = ['packages/plugins/board/a.ts', 'packages/plugins/agenda/a.ts', 'packages/plugins/agenda/b.ts'];
  const lines = new Map([
    ['packages/plugins/board/a.ts', 500],
    ['packages/plugins/agenda/a.ts', 3],
    ['packages/plugins/agenda/b.ts', 4],
  ]);
  const result = check(changed, '', lines);
  expect(result.home).toEqual(['packages/plugins/board']);
  expect(result.missing).toEqual(['packages/plugins/agenda/a.ts', 'packages/plugins/agenda/b.ts']);
  const tie = check(
    ['packages/plugins/board/a.ts', 'packages/plugins/agenda/a.ts'],
    '',
    new Map([
      ['packages/plugins/board/a.ts', 5],
      ['packages/plugins/agenda/a.ts', 5],
    ]),
  );
  expect(tie.home).toEqual(['packages/plugins/board', 'packages/plugins/agenda']);
  expect(tie.ok).toBe(true);
});

test('a Home: line overrides the changed lines, by folder, short name or npm name', () => {
  const changed = ['packages/plugins/board/a.ts', 'packages/plugins/agenda/a.ts', 'packages/plugins/agenda/b.ts'];
  for (const line of [
    'Home: agenda',
    'home: plugin-agenda',
    'Home: @ferretry/plugin-agenda',
    'Home: `packages/plugins/agenda`',
  ]) {
    const result = check(changed, body(line));
    expect(result.homeFrom).toBe('home-line');
    expect(result.home).toEqual(['packages/plugins/agenda']);
    expect(result.missing).toEqual(['packages/plugins/board/a.ts']);
  }
  expect(check(changed, body('Home: board, agenda')).ok).toBe(true);
  const unknown = check(changed, body('Home: nonesuch'));
  expect(unknown.ok).toBe(false);
  expect(unknown.problems[0]).toContain('"nonesuch"');
});

test('an empty body fails when outside files exist, and passes when none do', () => {
  expect(check(['packages/plugins/board/a.ts', 'README.md'], '').ok).toBe(false);
  expect(check(['packages/plugins/board/a.ts', 'README.md'], '').hasSection).toBe(false);
  expect(check(['packages/plugins/board/a.ts'], '').ok).toBe(true);
});

test('a PR that touches no package at all has every file outside', () => {
  const result = check(
    ['docs/a.md', '.github/workflows/ci.yaml'],
    body('## Outside files', '- docs/a.md: x docs', '- .github/**: wiring'),
  );
  expect(result.home).toEqual([]);
  expect(result.ok).toBe(true);
  expect(check(['docs/a.md'], '').missing).toEqual(['docs/a.md']);
});

test('the template: an empty section with only a comment has no entries', () => {
  const template = '## Outside files\n\n<!-- one line per file outside your plugin folder: `path: why` -->\n';
  expect(outsideEntries(template)).toEqual([]);
  expect(check(['packages/plugins/board/a.ts', 'README.md'], template).ok).toBe(false);
  expect(check(['packages/plugins/board/a.ts'], template).ok).toBe(true);
});

test('the section ends at the next heading; another heading of the same words is not it', () => {
  const text = body(
    '## Outside files',
    '- a.md: reason one',
    '## Test plan',
    '- b.md: not an outside file',
    '### Outside files',
    '- c.md: no',
  );
  expect(outsideEntries(text)?.map(entry => entry.pattern)).toEqual(['a.md']);
  expect(outsideEntries(body('Outside files', '- a.md: x'))).toBeUndefined();
  expect(outsideEntries(body('## Outside files and more', '- a.md: x'))).toBeUndefined();
  expect(homeLine(body('<!-- Home: board -->'))).toBeUndefined();
});

test('package ownership: the longest package folder wins, a loose file has none', () => {
  expect(packageOf('packages/core/kernel/src/a.ts', ROOTS)).toBe('packages/core/kernel');
  expect(packageOf('packages/app/src/a.ts', ROOTS)).toBe('packages/app');
  expect(packageOf('packages/app-other/a.ts', ROOTS)).toBeUndefined();
  expect(packageOf('README.md', ROOTS)).toBeUndefined();
});

// ── run(): the real git read, over a repository with a base, a branch, and a merge from the base ──────────────────

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => {
  const out = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
};

const put = (root: string, file: string, text: string): void => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
};

const repo = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'one-folder-'));
  dirs.push(root);
  git(root, 'init', '-q', '-b', 'main');
  put(root, 'package.json', JSON.stringify({ name: 'r', workspaces: ['packages/*', 'packages/plugins/*'] }));
  put(root, 'packages/plugins/board/package.json', '{"name":"@ferretry/plugin-board"}');
  put(root, 'packages/plugins/agenda/package.json', '{"name":"@ferretry/plugin-agenda"}');
  put(root, 'shared.json', '{}');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
};

const env = (root: string, text: string) => ({
  FY_ONE_FOLDER_EVENT: 'pull_request',
  FY_ONE_FOLDER_BASE_REF: 'rebuild/5.0-after',
  FY_ONE_FOLDER_BASE_SHA: git(root, 'rev-parse', 'main'),
  FY_ONE_FOLDER_HEAD_SHA: git(root, 'rev-parse', 'HEAD'),
  FY_ONE_FOLDER_PR_BODY: text,
});

test('run: a merge from the base never counts; only the PR own diff does', () => {
  const root = repo();
  git(root, 'checkout', '-q', '-b', 'feature');
  put(root, 'packages/plugins/board/a.ts', 'export const a = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'feature');
  // the base moves on and touches a shared file; the feature merges it in
  git(root, 'checkout', '-q', 'main');
  put(root, 'shared.json', '{"moved":true}');
  git(root, 'commit', '-qam', 'base moves');
  git(root, 'checkout', '-q', 'feature');
  git(root, 'merge', '-q', '--no-edit', 'main');
  const result = run(root, env(root, ''));
  expect(result.lines.join('\n')).toContain('home = packages/plugins/board');
  expect(result.code).toBe(0);
});

test('run: a shared file fails with the file named, passes once the body explains it', () => {
  const root = repo();
  git(root, 'checkout', '-q', '-b', 'feature');
  put(root, 'packages/plugins/board/a.ts', 'export const a = 1;\n');
  put(root, 'shared.json', '{"board":true}');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'feature');
  const failed = run(root, env(root, 'Summary only'));
  expect(failed.code).toBe(1);
  expect(failed.lines.join('\n')).toContain('✗ shared.json');
  const passed = run(root, env(root, '## Outside files\n- shared.json: board registers itself here'));
  expect(passed.code).toBe(0);
});

test('run: other events and other bases are not checked; a missing sha fails with a reason', () => {
  const root = repo();
  expect(run(root, { ...env(root, ''), FY_ONE_FOLDER_EVENT: 'push' }).code).toBe(0);
  expect(run(root, { ...env(root, ''), FY_ONE_FOLDER_BASE_REF: 'main' }).code).toBe(0);
  const noSha = run(root, { ...env(root, ''), FY_ONE_FOLDER_BASE_SHA: '' });
  expect(noSha.code).toBe(1);
  expect(noSha.lines.join('\n')).toContain('could not be computed');
});

test('packageRoots expands the workspace globs to the folders that hold a package.json', () => {
  const root = repo();
  put(root, 'packages/plugins/notapkg/readme.md', 'x');
  expect(packageRoots(root).sort()).toEqual(['packages/plugins/agenda', 'packages/plugins/board']);
});

// ── the workflow wiring ────────────────────────────────────────────────────────────────────────────────────────────

type Step = { run?: string; env?: Record<string, string> };
type Workflow = {
  on: { pull_request: { branches: string[]; types: string[] } };
  jobs: Record<string, { if?: string; 'timeout-minutes'?: number; steps: Step[] }>;
};
const load = (name: string): Workflow =>
  Bun.YAML.parse(readFileSync(join(import.meta.dir, '../../.github/workflows', name), 'utf8')) as Workflow;

test('one-folder.yaml: its own workflow, base-gated, re-run on an edited body, body as env data, no gh call', () => {
  const workflow = load('one-folder.yaml');
  // an `edited` event (a body fix) re-runs it, and only a pull request into the rule's base starts it
  expect(workflow.on.pull_request.types).toEqual(['opened', 'synchronize', 'reopened', 'edited']);
  expect(workflow.on.pull_request.branches).toEqual(['rebuild/5.0-after']);
  const job = workflow.jobs['one-folder'];
  expect(job?.['timeout-minutes']).toBeGreaterThan(0);
  expect(job?.if).toBeUndefined();
  const steps = job?.steps ?? [];
  // the body is an env value of the step that runs the script, and interpolated into no script
  const runner = steps.find(step => String(step.run ?? '').includes('one-folder.ts'));
  expect(runner?.env?.FY_ONE_FOLDER_PR_BODY).toBe('${{ github.event.pull_request.body }}');
  for (const step of steps) expect(String(step.run ?? '')).not.toContain('github.event');
  expect(JSON.stringify(job)).not.toMatch(/\bgh\b/);
  // the same merge-base fetch the changed-plugin scope uses
  expect(steps.some(step => String(step.run ?? '').includes('scope-fetch.sh'))).toBe(true);
});

test('ci.yaml is untouched by the rule: no one-folder job in it (its verdict needs every job it holds)', () => {
  expect(Object.keys(load('ci.yaml').jobs)).not.toContain('one-folder');
});
