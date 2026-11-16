import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** `base`: the pending list at the base commit; null = the base holds no list (the bootstrap). */
const repo = (files: Record<string, string>, base: string | null = null): string => {
  const root = mkdtempSync(join(tmpdir(), 'fy-unit-budgets-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const git = (...args: string[]) =>
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: root,
    });
  git('init', '--quiet');
  // The BASE commit holds only the base's pending list (or nothing); the files above are the working tree on top of it.
  const pending = join(root, 'config/perf-pending.txt');
  const working = base === null ? undefined : base;
  const keep = join(root, '.base-keep');
  writeFileSync(keep, '');
  if (working !== undefined) {
    const current = (() => {
      try {
        return readFileSync(pending, 'utf8');
      } catch {
        return undefined;
      }
    })();
    mkdirSync(dirname(pending), { recursive: true });
    writeFileSync(pending, working);
    git('add', '.base-keep', 'config/perf-pending.txt');
    git('commit', '--quiet', '-m', 'base');
    if (current === undefined) rmSync(pending);
    else writeFileSync(pending, current);
  } else {
    git('add', '.base-keep');
    git('commit', '--quiet', '-m', 'base');
  }
  return root;
};
const run = (root: string, base?: string) => {
  const result = spawnSync('bash', [SCRIPT], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FY_CHECK_BASE: base ?? 'HEAD' },
  });
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

// THE RATCHET: the pending list may only shrink against the base's list.
const BUDGET = 'const t = performance.now();\n';
const OTHER = 'packages/plugins/y/tests/unit/y.test.ts';

test('a new pending entry absent from the base list is refused', () => {
  const result = run(repo({ [UNIT]: BUDGET, 'config/perf-pending.txt': `${UNIT}\n` }, '# none\n'));
  expect(result.status).toBe(1);
  expect(result.out).toContain(`${UNIT} is not on the list at`);
});

test('re-adding an entry the base list had removed is refused', () => {
  const result = run(
    repo({ [UNIT]: BUDGET, [OTHER]: BUDGET, 'config/perf-pending.txt': `${UNIT}\n${OTHER}\n` }, `${OTHER}\n`),
  );
  expect(result.status).toBe(1);
  expect(result.out).toContain(`${UNIT} is not on the list at`);
  expect(result.out).not.toContain(`${OTHER} is not on the list`);
});

test('shrinking the list passes', () => {
  const result = run(repo({ [UNIT]: BUDGET, 'config/perf-pending.txt': `${UNIT}\n` }, `# kept\n${UNIT}\n${OTHER}\n`));
  expect(result.status).toBe(0);
  expect(result.out).toContain('(config/perf-pending.txt): 1');
});

test('a base with no list is the bootstrap: the current list is accepted', () => {
  const result = run(repo({ [UNIT]: BUDGET, 'config/perf-pending.txt': `${UNIT}\n` }));
  expect(result.status).toBe(0);
});

test('a base that cannot be read fails instead of skipping the ratchet', () => {
  const root = repo({ [UNIT]: BUDGET, 'config/perf-pending.txt': `${UNIT}\n` });
  const result = run(root, 'refs/does-not-exist');
  expect(result.status).toBe(1);
  expect(result.out).toContain('cannot read the base refs/does-not-exist');
});
