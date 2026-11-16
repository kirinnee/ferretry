import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCases } from './perf-junit';

// scripts/ci/perf-tier.sh with a FAKE one-process runner (FY_PERF_RUN_FILES), so the verdict policy is proved without
// timing anything: a pull request reports and exits 0; main re-runs only the failing files once and fails on a second miss.
const REPO = join(import.meta.dir, '..', '..');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Behaviour by file name: `ok` always passes, `flaky` fails its FIRST run only, `bad` always fails, `crash` dies with
// no report. A run's tests take 0.5 s when they pass and 2.5 s when they fail, so the times are visible in the output.
const FAKE = `#!/usr/bin/env bash
out="$1"; shift; mkdir -p "$out"
status=0; crash=false
{ echo '<testsuites>'; } >"$out/junit.xml"
for f in "$@"; do
  f="\${f#./}"; base="$(basename "$f")"
  count=$(( $(cat "$FY_FAKE_STATE/$base" 2>/dev/null || echo 0) + 1 )); echo "$count" >"$FY_FAKE_STATE/$base"
  failed=false
  case "$base" in
    flaky*) [[ $count -eq 1 ]] && failed=true ;;
    bad*) failed=true ;;
    crash*) crash=true ;;
  esac
  if [[ $failed == true ]]; then
    status=1
    echo "  <testcase name=\\"$base is under budget\\" classname=\\"s\\" time=\\"2.5\\" file=\\"$f\\" line=\\"1\\"><failure type=\\"AssertionError\\" /></testcase>" >>"$out/junit.xml"
  else
    echo "  <testcase name=\\"$base is under budget\\" classname=\\"s\\" time=\\"0.5\\" file=\\"$f\\" line=\\"1\\" />" >>"$out/junit.xml"
  fi
done
echo '</testsuites>' >>"$out/junit.xml"
if [[ $crash == true ]]; then rm -f "$out/junit.xml"; echo "boom" >"$out/console.log"; exit 1; fi
echo "ran $*" >"$out/console.log"
exit $status
`;

const tier = (files: string[], env: Record<string, string> = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'fy-perf-tier-'));
  roots.push(root);
  mkdirSync(join(root, 'state'));
  const runner = join(root, 'fake-runner.sh');
  writeFileSync(runner, FAKE);
  chmodSync(runner, 0o755);
  const summary = join(root, 'summary.md');
  writeFileSync(summary, '');
  const result = spawnSync(join(REPO, 'scripts/ci/perf-tier.sh'), files, {
    cwd: REPO,
    encoding: 'utf8',
    env: {
      ...process.env,
      FY_PERF_RUN_FILES: runner,
      FY_PERF_OUT: join(root, 'out'),
      FY_FAKE_STATE: join(root, 'state'),
      GITHUB_STEP_SUMMARY: summary,
      FY_CI_PERF_PARALLEL: '2',
      ...env,
    },
  });
  const runs = (base: string): number => {
    try {
      return Number(readFileSync(join(root, 'state', base), 'utf8'));
    } catch {
      return 0;
    }
  };
  return {
    status: result.status,
    out: `${result.stdout}${result.stderr}`,
    summary: readFileSync(summary, 'utf8'),
    runs,
  };
};

const files = [
  'packages/x/tests/perf/ok.test.ts',
  'packages/x/tests/perf/flaky.test.ts',
  'packages/x/tests/perf/ok2.test.ts',
];

test('main, everything within budget: passes with no re-run', () => {
  const r = tier(['packages/x/tests/perf/ok.test.ts', 'packages/x/tests/perf/ok2.test.ts']);
  expect(r.status).toBe(0);
  expect(r.summary).toContain('perf: all 2 files within budget');
  expect(r.runs('ok.test.ts')).toBe(1);
});

test('main, a file fails then passes on the re-run: passes, re-runs ONLY the failing file, prints both attempts', () => {
  const r = tier(files);
  expect(r.status).toBe(0);
  expect(r.runs('flaky.test.ts')).toBe(2);
  expect(r.runs('ok.test.ts')).toBe(1);
  expect(r.runs('ok2.test.ts')).toBe(1);
  expect(r.summary).toContain('attempt 1: 2500 ms FAIL');
  expect(r.summary).toContain('attempt 2: 500 ms pass');
  expect(r.summary).toContain('perf-flaked (failed once, passed on the re-run): packages/x/tests/perf/flaky.test.ts');
  expect(r.summary).not.toContain('perf-failed:');
});

test('main, a file fails twice in a row: exit 1 and `perf-failed:` names it', () => {
  const r = tier([...files, 'packages/x/tests/perf/bad.test.ts']);
  expect(r.status).toBe(1);
  expect(r.runs('bad.test.ts')).toBe(2);
  expect(r.summary).toContain('perf-failed: packages/x/tests/perf/bad.test.ts');
  expect(r.summary).toContain('attempt 2: 2500 ms FAIL');
  expect(r.summary).not.toContain('perf-failed: packages/x/tests/perf/flaky.test.ts');
});

test('main, a process that dies with no report fails its whole share, never a pass', () => {
  const r = tier(['packages/x/tests/perf/crash.test.ts']);
  expect(r.status).toBe(1);
  expect(r.summary).toContain('perf-failed: packages/x/tests/perf/crash.test.ts');
  expect(r.runs('crash.test.ts')).toBe(2);
});

test('pull request: report-only exits 0, shows the over-budget line, the files and the times, re-runs nothing', () => {
  const r = tier([...files, 'packages/x/tests/perf/bad.test.ts'], { FY_PERF_REPORT_ONLY: 'true' });
  expect(r.status).toBe(0);
  expect(r.summary).toContain('⚠ perf: 2 over budget (report-only on PRs)');
  expect(r.summary).toContain('perf-failed: packages/x/tests/perf/bad.test.ts packages/x/tests/perf/flaky.test.ts');
  expect(r.summary).toContain('attempt 1: 2500 ms FAIL');
  expect(r.out).toContain('::warning title=Performance Tests (report-only on PRs)::');
  expect(r.runs('bad.test.ts')).toBe(1);
  expect(r.runs('flaky.test.ts')).toBe(1);
});

test('pull request, everything within budget: says so', () => {
  const r = tier(['packages/x/tests/perf/ok.test.ts'], { FY_PERF_REPORT_ONLY: 'true' });
  expect(r.status).toBe(0);
  expect(r.summary).toContain('perf: all 1 files within budget');
});

test('perf-junit reads bun reports: failures, skips, escapes and times', () => {
  const cases = parseCases(`<testsuites><testsuite name="a">
    <testcase name="a &lt; b" classname="c" time="0.25" file="f.ts" line="1" />
    <testcase name="boom" classname="c" time="1.5" file="f.ts" line="2"><failure type="x">no</failure></testcase>
    <testcase name="later" classname="c" time="0" file="g.ts" line="3"><skipped /></testcase>
  </testsuite></testsuites>`);
  expect(cases).toEqual([
    { file: 'f.ts', name: 'a < b', ms: 250, verdict: 'pass' },
    { file: 'f.ts', name: 'boom', ms: 1500, verdict: 'FAIL' },
    { file: 'g.ts', name: 'later', ms: 0, verdict: 'skip' },
  ]);
});
