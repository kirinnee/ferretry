import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// unit-budgets.sh over a throwaway repository: a speed or size budget in the unit tier is refused unless its file is
// on the (shrinking) pending list; a listed file with no budget left is refused too; a fake clock may carry a reasoned
// `// not-a-budget:` marker; the perf tier may hold any budget.
const SCRIPT = join(import.meta.dir, 'unit-budgets.sh');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const repo = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'fy-unit-budgets-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  spawnSync('git', ['init', '--quiet'], { cwd: root });
  return root;
};
const run = (root: string) => {
  const result = spawnSync('bash', [SCRIPT], { cwd: root, encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
};
const UNIT = 'packages/plugins/x/tests/unit/x.test.ts';
const PERF = 'packages/plugins/x/tests/perf/x.test.ts';

test('a clean unit tier passes and says the list is empty', () => {
  const result = run(repo({ [UNIT]: "test('x', () => expect(1).toBe(1));\n", 'config/perf-pending.txt': '# none\n' }));
  expect(result.status).toBe(0);
  expect(result.out).toContain('(config/perf-pending.txt): 0');
});

for (const [what, line] of [
  ['a performance.now() read', 'const t = performance.now();'],
  ['a Bun.nanoseconds() read', 'const t = Bun.nanoseconds();'],
  ['a process.hrtime() read', 'const t = process.hrtime.bigint();'],
  ['a CPU counter read', 'const t = process.threadCpuUsage();'],
  ['a memory counter read', 'const m = process.memoryUsage();'],
  ['the linear-time helper', "import { linearTime } from '@ferretry/std/testing/linear-time';"],
  ['a Date.now() difference under a bound', 'expect(Date.now() - start).toBeLessThan(100);'],
  ['a named duration under a bound', 'should(elapsedMs).be.below(100);'],
  ['a resident-memory bound', 'expect(rssMb).toBeLessThan(200);'],
] as const) {
  test(`${what} in an unlisted unit file is refused`, () => {
    const result = run(repo({ [UNIT]: `${line}\n`, 'config/perf-pending.txt': '' }));
    expect(result.status).toBe(1);
    expect(result.out).toContain(`${UNIT}:1: the unit tier holds a speed or size budget`);
    expect(result.out).toContain('packages/plugins/x/tests/perf/x.test.ts');
  });
}

test('a listed file may keep its budget until it moves, and the count says how many are left', () => {
  const result = run(repo({ [UNIT]: 'const t = performance.now();\n', 'config/perf-pending.txt': `${UNIT}\n` }));
  expect(result.status).toBe(0);
  expect(result.out).toContain('(config/perf-pending.txt): 1');
});

test('a listed file with no budget left is refused, so the list cannot rot', () => {
  const result = run(repo({ [UNIT]: "test('x', () => {});\n", 'config/perf-pending.txt': `${UNIT}\n` }));
  expect(result.status).toBe(1);
  expect(result.out).toContain(`${UNIT} holds no speed or size budget any more (or is gone); delete its line`);
});

test('a fake clock may read a clock with a reasoned marker, and one without a reason is refused', () => {
  const fake = 'packages/plugins/x/tests/unit/support/clock.ts';
  const ok = run(
    repo({ [fake]: 'const real = performance.now(); // not-a-budget: the fake starts from the real origin\n' }),
  );
  expect(ok.status).toBe(0);
  expect(ok.out).toContain(`not a budget: ${fake}:1: the fake starts from the real origin`);
  const bare = run(repo({ [fake]: 'const real = performance.now(); // not-a-budget:\n' }));
  expect(bare.status).toBe(1);
  expect(bare.out).toContain('a not-a-budget marker needs a reason');
});

test('the perf tier may hold any budget', () => {
  const result = run(repo({ [PERF]: 'expect(performance.now() - start).toBeLessThan(100);\n' }));
  expect(result.status).toBe(0);
});
