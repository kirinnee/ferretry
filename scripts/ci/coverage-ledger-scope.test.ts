import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// coverage-ledger.sh over a tiny repository: a platform package (kern), a selected plugin (x) and a skipped plugin (y).
// y's lib file is loaded by a platform test but only partly exercised, which is exactly what a SCOPED run must not judge.
const REAL_SCRIPTS = join(import.meta.dir, '..');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SOURCE = 'export const value = 1;\n';
const record = (root: string, rel: string, found: number, hit: number): string =>
  `SF:${join(root, rel)}\nLF:${found}\nLH:${hit}\nend_of_record\n`;

const KERN = 'packages/core/kern/lib/a.ts';
const X = 'packages/plugins/x/daemon/lib/b.ts';
const Y = 'packages/plugins/y/daemon/lib/c.ts';

const setup = (lcov: (root: string) => string, scope: unknown): { root: string; scopeFile: string } => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-scope-'));
  dirs.push(root);
  for (const rel of [KERN, X, Y]) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), SOURCE);
  }
  spawnSync('git', ['init', '--quiet'], { cwd: root });
  symlinkSync(REAL_SCRIPTS, join(root, 'scripts'));
  mkdirSync(join(root, 'coverage/unit'), { recursive: true });
  writeFileSync(join(root, 'coverage/unit/lcov.info'), lcov(root));
  const scopeFile = join(root, 'scope.json');
  writeFileSync(scopeFile, JSON.stringify(scope));
  return { root, scopeFile };
};

const SCOPED = { mode: 'scoped', skipped: [{ name: '@ferretry/plugin-y', rel: 'packages/plugins/y' }] };
const run = (root: string, scopeFile: string | undefined) => {
  const env = { ...process.env, GITHUB_STEP_SUMMARY: '/dev/null' } as Record<string, string | undefined>;
  delete env.FY_CI_SCOPE_FILE;
  if (scopeFile !== undefined) env.FY_CI_SCOPE_FILE = scopeFile;
  const result = spawnSync('bash', ['./scripts/ci/coverage-ledger.sh', 'unit', 'coverage/unit/lcov.info'], {
    cwd: root,
    encoding: 'utf8',
    env: env as Record<string, string>,
  });
  return { status: result.status, text: `${result.stdout}${result.stderr}` };
};

const partlyY = (root: string): string => record(root, KERN, 4, 4) + record(root, X, 3, 3) + record(root, Y, 5, 2);

test('a SCOPED ledger leaves the skipped plugin out, passes, and never says the complete-ledger sentence', () => {
  const { root, scopeFile } = setup(partlyY, SCOPED);
  const { status, text } = run(root, scopeFile);
  expect(status).toBe(0);
  expect(text).toContain('SCOPED coverage ledger');
  expect(text).toContain('NOT the complete unit production ledger');
  expect(text).not.toContain('matches the complete');
});

test('the same ledger without a scope is red: the skipped plugin is judged like any other', () => {
  const { root } = setup(partlyY, SCOPED);
  const { status, text } = run(root, undefined);
  expect(status).toBe(1);
  expect(text).toContain('coverage is not 100%');
});

test('a SCOPED ledger still judges the platform packages and the selected plugins', () => {
  const lowSelected = setup(root => record(root, KERN, 4, 4) + record(root, X, 3, 2) + record(root, Y, 5, 5), SCOPED);
  expect(run(lowSelected.root, lowSelected.scopeFile).status).toBe(1);
  const lowPlatform = setup(root => record(root, KERN, 4, 3) + record(root, X, 3, 3) + record(root, Y, 5, 5), SCOPED);
  expect(run(lowPlatform.root, lowPlatform.scopeFile).status).toBe(1);
});

test('a source file of a selected plugin that is missing from the ledger is red, one of a skipped plugin is not', () => {
  const missingSelected = setup(root => record(root, KERN, 4, 4), SCOPED);
  const red = run(missingSelected.root, missingSelected.scopeFile);
  expect(red.status).toBe(1);
  expect(red.text).toContain('source file missing from coverage ledger: packages/plugins/x/daemon/lib/b.ts');
  const missingSkipped = setup(root => record(root, KERN, 4, 4) + record(root, X, 3, 3), SCOPED);
  expect(run(missingSkipped.root, missingSkipped.scopeFile).status).toBe(0);
});

test('a scope file that is not a SCOPED decision is refused, so a FULL run cannot be judged as a scoped one', () => {
  const { root, scopeFile } = setup(partlyY, { mode: 'full', reason: 'x' });
  const { status, text } = run(root, scopeFile);
  expect(status).toBe(1);
  expect(text).toContain('is not a SCOPED decision');
});
