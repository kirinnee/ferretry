import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Fixture, fixture } from '../gen/tests/fixture.ts';

// quick.sh in DRY-RUN mode over a real git repository holding a small workspace: it decides the scope exactly as CI
// does and prints what it WOULD run (the unit files, the always-run parts, the proofs), without installing or testing.
const REAL_SCRIPTS = join(import.meta.dir, '..');
const BASE_REF = 'rebuild/5.0-after';

const fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
});

const git = (cwd: string, ...args: string[]): string => {
  const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
};

const TEST = "import { test } from 'bun:test';\ntest('x', () => {});\n";
const withTest = (extra: Record<string, string> = {}) => ({ files: { 'tests/unit/x.test.ts': TEST, ...extra } });

/** Plugins a, b (mentions a), c, d; one core package; each with one unit test, plus an integration test in c. */
const workspace = (): { fx: Fixture; base: string } => {
  const fx = fixture([
    { id: 'a', ...withTest() },
    { id: 'b', ...withTest({ 'daemon/lib/uses-a.ts': "import '@ferretry/plugin-a/contract';\n" }) },
    { id: 'c', ...withTest({ 'tests/integration/y.test.ts': TEST }) },
    { id: 'd', ...withTest() },
    { id: 'kern', core: true, ...withTest() },
  ]);
  fixtures.push(fx);
  fx.write('config/test-groups.json', JSON.stringify({ unit: [{ name: 'all', prefixes: ['packages/'] }], int: [] }));
  fx.write('docs/note.md', 'x\n');
  git(fx.root, 'init', '--quiet', '--initial-branch=main');
  // The real scripts, reached through a link the fixture repository does not track.
  symlinkSync(REAL_SCRIPTS, join(fx.root, 'scripts'));
  appendFileSync(join(fx.root, '.git/info/exclude'), 'scripts\ncoverage\n');
  git(fx.root, 'add', '--all');
  git(fx.root, 'commit', '--quiet', '-m', 'base');
  return { fx, base: git(fx.root, 'rev-parse', 'HEAD') };
};

const change = (fx: Fixture, path: string): string => {
  git(fx.root, 'checkout', '--quiet', '-b', `feature-${path.replace(/\W/g, '-')}`);
  mkdirSync(dirname(join(fx.root, path)), { recursive: true });
  writeFileSync(join(fx.root, path), `export const changed = '${path}';\n`);
  git(fx.root, 'add', '--all');
  git(fx.root, 'commit', '--quiet', '-m', 'change');
  return git(fx.root, 'rev-parse', 'HEAD');
};

/** This test runs inside Quick's own `scripts` part, whose environment already carries a real decision: drop it. */
const cleanEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !/^(FY_SCOPE_|FY_CI_|CI$|GITHUB_(STEP_SUMMARY|ENV)$)/.test(entry[0]),
    ),
  );

const dryRun = (fx: Fixture, env: Record<string, string>): { lines: string[]; status: number | null } => {
  const run = spawnSync('bash', ['./scripts/ci/quick.sh'], {
    cwd: fx.root,
    encoding: 'utf8',
    env: { ...cleanEnvironment(), FY_CI_QUICK_DRY_RUN: '1', GITHUB_STEP_SUMMARY: '/dev/null', ...env },
  });
  return { lines: `${run.stdout}${run.stderr}`.split('\n'), status: run.status };
};
const pr = (base: string, head: string, over: Record<string, string> = {}): Record<string, string> => ({
  FY_SCOPE_EVENT: 'pull_request',
  FY_SCOPE_BASE_REF: BASE_REF,
  FY_SCOPE_BASE_SHA: base,
  FY_SCOPE_HEAD_SHA: head,
  FY_SCOPE_LABELS: '[]',
  ...over,
});
const files = (lines: string[]): string[] =>
  lines.filter(line => line.startsWith('DRY RUN unit file ')).map(line => line.slice('DRY RUN unit file '.length));
const has = (lines: string[], text: string): boolean => lines.some(line => line.includes(text));

test('a SCOPED run lists the changed plugin, what mentions it and the platform tests, and keeps every gate', () => {
  const { fx, base } = workspace();
  const head = change(fx, 'packages/plugins/a/daemon/lib/new.ts');
  const { lines, status } = dryRun(fx, pr(base, head));
  expect(status).toBe(0);
  // The decision is printed at the top, before the plan.
  const decision = lines.findIndex(line => line.startsWith('CI scope: SCOPED'));
  expect(decision).toBeGreaterThanOrEqual(0);
  expect(decision).toBeLessThan(lines.findIndex(line => line.startsWith('DRY RUN')));
  expect(lines[decision]).toContain('2 of 4 plugins run, 2 skipped');
  expect(has(lines, 'run  packages/plugins/a (changed)')).toBe(true);
  expect(has(lines, 'run  packages/plugins/b (depends on @ferretry/plugin-a)')).toBe(true);
  expect(has(lines, 'skip packages/plugins/c')).toBe(true);
  // The unit tier is narrowed to a, b and the platform package; the integration file of c is never a unit file.
  expect(files(lines).sort()).toEqual([
    './packages/core/kern/tests/unit/x.test.ts',
    './packages/plugins/a/tests/unit/x.test.ts',
    './packages/plugins/b/tests/unit/x.test.ts',
  ]);
  expect(has(lines, 'DRY RUN unit test files: 3')).toBe(true);
  // Everything that judges the whole repository still runs, and the proofs say what they are.
  expect(has(lines, 'DRY RUN scope mode: scoped')).toBe(true);
  expect(has(lines, 'DRY RUN always-run parts: format gates build scripts')).toBe(true);
  expect(has(lines, 'DRY RUN check.ts guarantees --strict --tier unit --existence-only')).toBe(true);
  expect(has(lines, 'DRY RUN check.ts parity-ticks --tier unit')).toBe(true);
  expect(has(lines, 'coverage ledger: SCOPED')).toBe(true);
  expect(has(lines, 'NOT the complete unit production ledger')).toBe(true);
  expect(has(lines, 'complete unit production ledger') && !has(lines, 'ledger: complete')).toBe(true);
});

test('a SCOPED change to a plugin nothing mentions runs only it and the platform tests', () => {
  const { fx, base } = workspace();
  const head = change(fx, 'packages/plugins/d/daemon/lib/new.ts');
  const { lines } = dryRun(fx, pr(base, head));
  expect(files(lines).sort()).toEqual([
    './packages/core/kern/tests/unit/x.test.ts',
    './packages/plugins/d/tests/unit/x.test.ts',
  ]);
});

test('a change outside the plugins is FULL: every unit test, the complete ledger and the full proofs', () => {
  const { fx, base } = workspace();
  const head = change(fx, 'docs/other.md');
  const { lines } = dryRun(fx, pr(base, head));
  expect(has(lines, 'CI scope: FULL - docs/other.md is outside the plugin packages')).toBe(true);
  expect(has(lines, 'CI scope: SCOPED')).toBe(false);
  expect(files(lines)).toHaveLength(5);
  expect(has(lines, 'DRY RUN scope mode: full')).toBe(true);
  expect(
    has(lines, 'DRY RUN check.ts guarantees --strict --tier unit --results coverage/unit --results coverage/scripts'),
  ).toBe(true);
  expect(
    has(lines, 'DRY RUN check.ts parity-ticks --tier unit --results coverage/unit --results coverage/scripts'),
  ).toBe(true);
  expect(has(lines, 'DRY RUN coverage ledger: complete unit production ledger')).toBe(true);
  expect(has(lines, 'SCOPED')).toBe(false);
});

test('a push, another base, the full-ci label and a missing merge-base are FULL even for a one-plugin change', () => {
  const { fx, base } = workspace();
  const head = change(fx, 'packages/plugins/d/daemon/lib/new.ts');
  const cases: [Record<string, string>, string][] = [
    [pr(base, head, { FY_SCOPE_EVENT: 'push' }), 'the event is "push"'],
    [pr(base, head, { FY_SCOPE_EVENT: 'workflow_dispatch' }), 'the event is "workflow_dispatch"'],
    [pr(base, head, { FY_SCOPE_BASE_REF: 'rebuild/5.0' }), 'the base ref is "rebuild/5.0"'],
    [pr(base, head, { FY_SCOPE_BASE_REF: 'main' }), 'the base ref is "main"'],
    [pr(base, head, { FY_SCOPE_LABELS: '["full-ci"]' }), 'full-ci label'],
    [pr('0'.repeat(40), head), 'no merge-base'],
    [pr('', head), 'the base or head sha is missing'],
  ];
  for (const [env, reason] of cases) {
    const { lines, status } = dryRun(fx, env);
    expect(status).toBe(0);
    expect(has(lines, `CI scope: FULL - `)).toBe(true);
    expect(has(lines, reason)).toBe(true);
    expect(files(lines)).toHaveLength(5);
    expect(has(lines, 'DRY RUN scope mode: full')).toBe(true);
  }
});

test('outside CI (no scope environment at all) the run is FULL', () => {
  const { fx } = workspace();
  const { lines } = dryRun(fx, {});
  expect(has(lines, 'CI scope: FULL - the event is not a CI event')).toBe(true);
  expect(files(lines)).toHaveLength(5);
});

const READER =
  "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nreadFileSync(join(import.meta.dir, '../../../a/daemon/lib/new.ts'), 'utf8');\n";
const commitMore = (fx: Fixture, path: string, text: string): string => {
  mkdirSync(dirname(join(fx.root, path)), { recursive: true });
  writeFileSync(join(fx.root, path), text);
  git(fx.root, 'add', '--all');
  git(fx.root, 'commit', '--quiet', '-m', 'more');
  return git(fx.root, 'rev-parse', 'HEAD');
};

test('a test that reads another plugin source by path stays in the unit run inside a SKIPPED plugin', () => {
  const { fx } = workspace();
  const base = commitMore(fx, 'packages/plugins/c/tests/unit/reads-a.test.ts', READER);
  const head = change(fx, 'packages/plugins/d/daemon/lib/new.ts');
  const { lines } = dryRun(fx, pr(base, head));
  expect(has(lines, 'skip packages/plugins/c')).toBe(true);
  expect(has(lines, 'keep packages/plugins/c/tests/unit/reads-a.test.ts')).toBe(true);
  // The reader runs, the other test of its skipped plugin does not.
  expect(files(lines).sort()).toEqual([
    './packages/core/kern/tests/unit/x.test.ts',
    './packages/plugins/c/tests/unit/reads-a.test.ts',
    './packages/plugins/d/tests/unit/x.test.ts',
  ]);
});

test('a scope-deps declaration naming nothing fails the run BEFORE any filtering, scoped or FULL alike', () => {
  const { fx } = workspace();
  const base = commitMore(
    fx,
    'packages/plugins/c/tests/unit/bogus.test.ts',
    `// scope-deps: packages/plugins/a/nowhere\n${READER}`,
  );
  const head = change(fx, 'packages/plugins/d/daemon/lib/new.ts');
  for (const env of [pr(base, head), { FY_SCOPE_EVENT: 'push' }, {}]) {
    const { lines, status } = dryRun(fx, env);
    expect(status).not.toBe(0);
    expect(has(lines, 'packages/plugins/c/tests/unit/bogus.test.ts:1: scope-deps')).toBe(true);
    expect(has(lines, 'CI scope:')).toBe(false);
  }
});
