import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// check-base.sh + unit-budgets.sh over throwaway repositories with a local remote, as CI runs them: a one-commit
// checkout of the candidate, the base reachable only by fetching it. FY_BUDGET_BASE (the perf-pending ratchet's base)
// is chosen on its own, never from the unrelated after-merge ledger, so no event can read "no base list" by accident.
const ROOT = join(import.meta.dir, '..', '..');
const CHECK_BASE = join(ROOT, 'scripts/ci/check-base.sh');
const UNIT_BUDGETS = join(ROOT, 'scripts/validate/unit-budgets.sh');
const ANCHOR = '7573243d27c42a4cdb23cdfdee7bd954c911c7e6';
const ZERO = '0'.repeat(40);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const put = (root: string, path: string, text: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const run = (cwd: string, args: string[], env: Record<string, string> = {}) => {
  const result = spawnSync(args[0] as string, args.slice(1), {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FY_CHECK_BASE: '', FY_BUDGET_BASE: '', ...env },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
};
const git = (cwd: string, ...args: string[]): string => {
  const done = run(cwd, [
    'git',
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    ...args,
  ]);
  if (done.status !== 0) throw new Error(done.out);
  return done.out.trim();
};

const LISTED = 'packages/x/tests/unit/x.test.ts';
const ADDED = 'packages/y/tests/unit/y.test.ts';
const BUDGET = 'const start = performance.now();\n';

/** A remote whose first commit is the anchor's stand-in (borrowing the real repository's objects so ANCHOR resolves). */
const remote = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'fy-check-base-'));
  dirs.push(dir);
  const origin = join(dir, 'remote');
  mkdirSync(origin);
  git(origin, 'init', '--quiet', '-b', 'main');
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const objects = git(ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  put(origin, '.git/objects/info/alternates', `${join(objects, 'objects')}\n`);
  return origin;
};
const commit = (origin: string, message: string): string => {
  git(origin, 'add', '-A');
  git(origin, 'commit', '--quiet', '-m', message);
  return git(origin, 'rev-parse', 'HEAD');
};
/** The candidate: one commit that LISTS one more exemption than the remote's base does. */
const candidate = (origin: string): string => {
  const dir = mkdtempSync(join(dirname(origin), 'work-'));
  git(dir, 'init', '--quiet');
  git(dir, 'remote', 'add', 'origin', origin);
  put(dir, 'config/perf-pending.txt', `${LISTED}\n${ADDED}\n`);
  put(dir, LISTED, BUDGET);
  put(dir, ADDED, BUDGET);
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'candidate');
  return dir;
};
/** Runs check-base.sh with the event's env, then the ratchet with what check-base wrote to $GITHUB_ENV. */
const ci = (work: string, event: Record<string, string>) => {
  const envFile = join(work, '..', `github-env-${Math.random()}`);
  writeFileSync(envFile, '');
  const selected = run(work, ['bash', CHECK_BASE], {
    FY_PR_BASE_SHA: '',
    FY_PUSH_BEFORE: '',
    FY_DEFAULT_BRANCH: 'main',
    GITHUB_ENV: envFile,
    ...event,
  });
  const exported = Object.fromEntries(
    readFileSync(envFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => line.split('=') as [string, string]),
  );
  const ratchet = selected.status === 0 ? run(work, ['bash', UNIT_BUDGETS], exported) : undefined;
  return { selected, exported, ratchet };
};
const withList = (origin: string, ledger: boolean): string => {
  put(origin, 'config/perf-pending.txt', `${LISTED}\n`);
  put(origin, LISTED, BUDGET);
  if (ledger) put(origin, 'docs/rebuild/after-merge.json', '{}\n');
  return commit(origin, 'baseline');
};
const rejected = (result: ReturnType<typeof ci>, base: string) => {
  expect(result.selected.status).toBe(0);
  expect(result.exported.FY_BUDGET_BASE).toBe(base);
  expect(result.ratchet?.status).toBe(1);
  expect(result.ratchet?.out).toContain(`${ADDED} is not on the list at ${base}`);
};

test('a pull request: the base list rejects an added exemption, FY_CHECK_BASE stays the ledger base', () => {
  const origin = remote();
  const base = withList(origin, true);
  const result = ci(candidate(origin), { FY_PR_BASE_SHA: base });
  rejected(result, base);
  expect(result.exported.FY_CHECK_BASE).toBe(base);
});

test('a push: the commit before the push is the budget base', () => {
  const origin = remote();
  const base = withList(origin, true);
  rejected(ci(candidate(origin), { FY_PUSH_BEFORE: base }), base);
});

test('a dispatch (and a branch first push): the default branch tip is the budget base', () => {
  const origin = remote();
  const base = withList(origin, true);
  rejected(ci(candidate(origin), {}), base);
  rejected(ci(candidate(origin), { FY_PUSH_BEFORE: ZERO }), base);
});

test('a pull request into a base without after-merge.json still rejects; FY_CHECK_BASE falls back to the anchor', () => {
  const origin = remote();
  const base = withList(origin, false);
  const result = ci(candidate(origin), { FY_PR_BASE_SHA: base });
  rejected(result, base);
  expect(result.exported.FY_CHECK_BASE).toBe(ANCHOR);
});

test('the introduction: a base without perf-pending.txt is the bootstrap and accepts the list', () => {
  const origin = remote();
  put(origin, 'README.md', 'x\n');
  const base = commit(origin, 'before the list');
  const result = ci(candidate(origin), { FY_PR_BASE_SHA: base });
  expect(result.exported.FY_BUDGET_BASE).toBe(base);
  expect(result.ratchet?.status).toBe(0);
});

test('a base that cannot be fetched fails the job, and a dispatch with no default branch fails too', () => {
  const origin = remote();
  withList(origin, true);
  const work = candidate(origin);
  expect(ci(work, { FY_PR_BASE_SHA: 'f'.repeat(40) }).selected.status).not.toBe(0);
  expect(ci(work, { FY_DEFAULT_BRANCH: 'no-such-branch' }).selected.status).not.toBe(0);
});
