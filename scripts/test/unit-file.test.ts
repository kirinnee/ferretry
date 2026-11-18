import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { configHolds, planFor, ranNoTests } from './unit-file';

// scripts/test/unit-file.ts over a FIXTURE repository (FY_UNIT_FILE_ROOT) whose bunfigs mirror the real tiers' shape, so
// the runner's decision is proved without running the real suite: a file outside the unit config says "not in this
// config" and exits 0; a file inside it keeps Bun's verdict, and a configured file that runs no test still exits 1.
const SCRIPT = join(import.meta.dir, 'unit-file.ts');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const bunfig = (ignore: string[]) => `[test]\nroot = "packages"\npathIgnorePatterns = ${JSON.stringify(ignore)}\n`;
const fixture = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'fy-unit-file-'));
  roots.push(root);
  const tiers = {
    unit: ['**/tests/integration/**', '**/tests/sit/**', '**/tests/realworld/**', '**/tests/perf/**'],
    int: ['**/tests/unit/**', '**/tests/sit/**', '**/tests/realworld/**', '**/tests/perf/**'],
    sit: ['**/tests/unit/**', '**/tests/integration/**', '**/tests/realworld/**', '**/tests/perf/**'],
    realworld: ['**/tests/unit/**', '**/tests/integration/**', '**/tests/sit/**', '**/tests/perf/**'],
    perf: ['**/tests/unit/**', '**/tests/integration/**', '**/tests/sit/**', '**/tests/realworld/**'],
  };
  for (const [tier, ignore] of Object.entries(tiers)) writeFileSync(join(root, `bunfig.${tier}.toml`), bunfig(ignore));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};
const run = (root: string, file: string) => {
  const result = Bun.spawnSync([process.execPath, SCRIPT, file], {
    cwd: root,
    env: { ...process.env, FY_UNIT_FILE_ROOT: root },
  });
  return { status: result.exitCode, out: result.stdout.toString() + result.stderr.toString() };
};
const PASSING = "import { expect, test } from 'bun:test';\ntest('ok', () => expect(1).toBe(1));\n";

test('a perf file the unit config leaves out says "not in this config", names the command, and exits 0', () => {
  const root = fixture({ 'packages/x/tests/perf/slow.test.ts': PASSING });
  const { status, out } = run(root, 'packages/x/tests/perf/slow.test.ts');
  expect(status).toBe(0);
  expect(out).toContain('is not in this config (bunfig.unit.toml)');
  expect(out).toContain('bun test --config=bunfig.perf.toml --timeout 120000 packages/x/tests/perf/slow.test.ts');
  expect(out).not.toContain('bun test v'); // nothing was run
});

test('an integration file, a scripts test and a test of a tool package each name their own runner and exit 0', () => {
  const root = fixture({
    'packages/x/tests/integration/a.test.ts': PASSING,
    'scripts/validate/seams.test.ts': PASSING,
    'tools/own/package.json': '{}',
    'tools/own/tests/unit/agenda.test.ts': PASSING,
  });
  const int = run(root, 'packages/x/tests/integration/a.test.ts');
  expect([int.status, int.out]).toEqual([0, expect.stringContaining('--config=bunfig.int.toml')]);
  const tooling = run(root, 'scripts/validate/seams.test.ts');
  expect([tooling.status, tooling.out]).toEqual([
    0,
    expect.stringContaining('bun test ./scripts/validate/seams.test.ts'),
  ]);
  const tool = run(root, 'tools/own/tests/unit/agenda.test.ts');
  expect([tool.status, tool.out]).toEqual([
    0,
    expect.stringContaining('cd tools/own && bun install --frozen-lockfile && bun test tests/unit/agenda.test.ts'),
  ]);
});

test('a file in the unit config runs, and a real failure keeps its non-zero exit', () => {
  const root = fixture({
    'packages/x/tests/unit/ok.test.ts': PASSING,
    'packages/x/tests/unit/bad.test.ts':
      "import { expect, test } from 'bun:test';\ntest('bad', () => expect(1).toBe(2));\n",
  });
  const ok = run(root, 'packages/x/tests/unit/ok.test.ts');
  expect(ok.status).toBe(0);
  expect(ok.out).not.toContain('not in this config');
  expect(run(root, 'packages/x/tests/unit/bad.test.ts').status).toBe(1);
});

test('a configured file with 0 tests still exits 1 and is never reported as "not in this config"', () => {
  const root = fixture({ 'packages/x/tests/unit/empty.test.ts': 'export {};\n' });
  const { status, out } = run(root, 'packages/x/tests/unit/empty.test.ts');
  expect(status).toBe(1);
  expect(out).toContain('is in the unit config but ran 0 tests');
  expect(out).not.toContain('not in this config');
});

test('a file no runner claims exits 1, and a missing file is a usage error', () => {
  const root = fixture({ 'tools/odd.test.ts': PASSING });
  const unclaimed = run(root, 'tools/odd.test.ts');
  expect(unclaimed.status).toBe(1);
  expect(unclaimed.out).toContain('claimed by no test config');
  expect(run(root, 'packages/x/tests/unit/missing.test.ts').status).toBe(2);
});

test('the plan reads the bunfig, not a copy of its patterns', () => {
  const root = fixture({});
  writeFileSync(join(root, 'bunfig.unit.toml'), bunfig(['**/tests/slow/**']));
  expect(configHolds(root, 'bunfig.unit.toml', 'packages/x/tests/slow/a.test.ts')).toBe(false);
  expect(configHolds(root, 'bunfig.unit.toml', 'packages/x/tests/perf/a.test.ts')).toBe(true);
  expect(configHolds(root, 'bunfig.unit.toml', 'packages/x/tests/unit/helper.ts')).toBe(false);
  expect(planFor(root, 'packages/x/tests/perf/a.test.ts').kind).toBe('run');
});

test('only "Ran 0 tests" output reads as a run that executed nothing', () => {
  expect(ranNoTests('\n 0 pass\n 0 fail\nRan 0 tests across 1 file. [56.00ms]')).toBe(true);
  expect(ranNoTests(' 1 pass\n 0 fail\nRan 1 test across 1 file. [5.00ms]')).toBe(false);
});

test("a scripts test listed in config/static-tests.txt says Static's guards part, any other says Quick's scripts part", () => {
  const root = fixture({
    'scripts/gen/tests/whole-tree.test.ts': PASSING,
    'scripts/validate/seams.test.ts': PASSING,
    'config/static-tests.txt': '# comment\n\nscripts/gen/tests/whole-tree.test.ts\n',
  });
  const listed = planFor(root, 'scripts/gen/tests/whole-tree.test.ts');
  expect(listed.kind === 'elsewhere' && listed.where).toContain('`guards` part');
  const other = planFor(root, 'scripts/validate/seams.test.ts');
  expect(other.kind === 'elsewhere' && other.where).toContain('`scripts` part');
});
