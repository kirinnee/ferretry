import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// test.sh and group-files.sh over throwaway repositories whose helper command (the scope filter, `find`) is shimmed to
// die: a crashed helper must FAIL the unit group / perf tier, never read as "everything scoped out" or "no test file".
const SCRIPTS = join(import.meta.dir, '..');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const put = (root: string, path: string, text: string, executable = false): string => {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
  if (executable) chmodSync(full, 0o755);
  return full;
};
const repo = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'fy-fail-closed-'));
  roots.push(root);
  spawnSync('git', ['init', '--quiet'], { cwd: root });
  // Setup stubs: only the runner under test is real.
  for (const path of ['scripts/ci/setup.sh', 'scripts/validate/pinned-toolchain.sh', 'scripts/local/gen.sh'])
    put(root, path, '#!/usr/bin/env bash\nexit 0\n', true);
  for (const path of ['scripts/ci/test.sh', 'scripts/ci/group-files.sh', 'scripts/ci/scope.ts'])
    put(root, path, spawnSync('cat', [join(SCRIPTS, '..', path)], { encoding: 'utf8' }).stdout, true);
  return root;
};
const run = (root: string, args: string[], env: Record<string, string> = {}) => {
  const clean: Record<string, string | undefined> = { ...process.env, GITHUB_STEP_SUMMARY: '/dev/null', ...env };
  delete clean.FY_CI_SCOPE_FILE;
  const result = spawnSync('bash', args, { cwd: root, encoding: 'utf8', env: { ...clean, ...env } });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
};

const unitWorkspace = (): { root: string; scope: string } => {
  const root = repo();
  put(root, 'config/test-groups.json', JSON.stringify({ unit: [{ name: 'all', prefixes: ['packages/'] }], int: [] }));
  put(root, 'packages/plugins/x/tests/unit/x.test.ts', "test('must run', () => {});\n");
  const scope = put(root, 'scope.json', JSON.stringify({ mode: 'scoped', skipped: [], alwaysRun: [] }));
  // \`bun\` itself is shimmed: the scope filter dies (137, the OOM killer's status) while everything else is untouched.
  put(root, 'bin/bun', '#!/usr/bin/env bash\necho "simulated scope.ts crash" >&2\nexit 137\n', true);
  return { root, scope };
};

test('a crashed scope filter fails group-files.sh instead of reading as every file scoped out', () => {
  const { root, scope } = unitWorkspace();
  const result = run(root, ['scripts/ci/group-files.sh', 'unit', 'all'], {
    FY_CI_SCOPE_FILE: scope,
    PATH: `${join(root, 'bin')}:${process.env.PATH}`,
  });
  expect(result.status).not.toBe(0);
  expect(result.out).toContain('the scope filter failed');
  expect(result.out).not.toContain('has no test file left');
});

test('a crashed scope filter fails test.sh unit <group> and writes no scoped-out marker', () => {
  const { root, scope } = unitWorkspace();
  const result = run(root, ['scripts/ci/test.sh', 'unit', 'all'], {
    FY_CI_SCOPE_FILE: scope,
    PATH: `${join(root, 'bin')}:${process.env.PATH}`,
  });
  expect(result.status).not.toBe(0);
  expect(result.out).not.toContain('scoped out, nothing to run');
  expect(existsSync(join(root, 'coverage/unit/groups/all/scoped-out'))).toBe(false);
});

const perfWorkspace = (findShim: string): { root: string; path: string } => {
  const root = repo();
  put(root, 'packages/x/tests/perf/fail.test.ts', 'throw new Error("must run");\n');
  put(root, 'bin/find', findShim.replace('REAL', Bun.which('find') ?? '/usr/bin/find'), true);
  return { root, path: `${join(root, 'bin')}:${process.env.PATH}` };
};

test('a failing find does not make the perf tier look empty', () => {
  const { root, path } = perfWorkspace('#!/usr/bin/env bash\necho "injected find failure" >&2\nexit 1\n');
  const result = run(root, ['scripts/ci/test.sh', 'perf'], { PATH: path });
  expect(result.status).not.toBe(0);
  expect(result.out).toContain('could not enumerate the perf test files');
  expect(result.out).not.toContain('nothing to run');
  expect(result.out).not.toContain('perf tests passed');
});

test('a find that prints partial output and then fails does not run a partial perf tier green', () => {
  const { root, path } = perfWorkspace(
    '#!/usr/bin/env bash\nREAL "$@"\necho "injected failure after partial output" >&2\nexit 1\n',
  );
  const result = run(root, ['scripts/ci/test.sh', 'perf'], { PATH: path });
  expect(result.status).not.toBe(0);
  expect(result.out).not.toContain('perf tests passed');
});

test('a perf tier that is genuinely empty still passes out loud', () => {
  const root = repo();
  mkdirSync(join(root, 'packages'));
  const result = run(root, ['scripts/ci/test.sh', 'perf']);
  expect(result.status).toBe(0);
  expect(result.out).toContain('the perf tier holds no test file yet');
});
