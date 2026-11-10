// Workflow-event and exact-head gate contracts. No integration tests, browsers or API writes.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slowestTest } from '../ci/unit-timings.ts';

type Job = {
  if?: string;
  needs?: string[];
  name: string;
  'runs-on'?: string[] | string;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps?: { name?: string; env?: Record<string, string> }[];
};
type Workflow = {
  jobs: Record<string, Job>;
  env?: Record<string, string>;
  concurrency: { group: string; 'cancel-in-progress': string };
};
const load = (name: string) => Bun.YAML.parse(readFileSync(`.github/workflows/${name}.yaml`, 'utf8')) as Workflow;
const ci = load('ci');
// The root typecheck covers this file under noUncheckedIndexedAccess. A job or field a fixture names must exist:
// a missing one fails the fixture here, saying which, instead of being asserted away.
const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`ci fixture: ${what} is missing`);
  return value;
};
const jobOf = (workflow: Workflow, name: string): Job => need(workflow.jobs[name], `job '${name}'`);
const conditionOf = (workflow: Workflow, name: string) => need(jobOf(workflow, name).if, `'if' of job '${name}'`);
const needsOf = (name: string) => need(jobOf(ci, name).needs, `'needs' of job '${name}'`);
const runsOnOf = (name: string) => need(jobOf(ci, name)['runs-on'], `'runs-on' of job '${name}'`);
const runsOnExpression = (name: string) => {
  const runsOn = runsOnOf(name);
  if (typeof runsOn !== 'string') throw new Error(`ci fixture: 'runs-on' of job '${name}' is not an expression`);
  return runsOn;
};
// Other workflows that share CI's pull-request label and concurrency rules. Realworld no longer runs on a pull
// request or a push at all (nightly and dispatch only), so it has none of those rules to hold.
const other: Workflow[] = [];
assert.deepEqual(
  slowestTest(
    '<testcase name="fast" time="0.1" file="a.ts" classname="one" /><testcase name="slow &amp; bounded" time="3.6" file="b.ts" classname="two" />',
  ),
  {
    name: 'b.ts › two › slow & bounded',
    seconds: 3.6,
  },
);
assert.equal(slowestTest('<testsuites />'), undefined);

// Evaluate only this contract's existing expression vocabulary, directly from the workflow.
const evaluate = (source: string, github: object, needs = {}, vars = {}, inputs = {}) => {
  const expression = source
    .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replaceAll('labels.*.name', 'labels.map(label => label.name)')
    // A hyphenated job id is subtraction to JavaScript: read it as a property name instead.
    .replace(/needs\.([A-Za-z0-9_-]+)/g, "needs['$1']");
  return new Function(
    'github',
    'needs',
    'vars',
    'inputs',
    'contains',
    'always',
    'cancelled',
    'failure',
    'format',
    'fromJSON',
    `return (${expression});`,
  )(
    github,
    needs,
    vars,
    inputs,
    (values: string[], value: string) => values.includes(value),
    () => true,
    () => false,
    () => false,
    (pattern: string, value: number | string) => pattern.replace('{0}', String(value)),
    JSON.parse,
  );
};
const event = (eventName: string, action = '', labels: string[] = [], label = '') => ({
  event_name: eventName,
  workflow: 'CI',
  ref: eventName === 'push' ? 'refs/heads/main' : 'refs/pull/42/merge',
  run_id: 123,
  event: { action, label: { name: label }, pull_request: { number: 42, labels: labels.map(name => ({ name })) } },
});
const fullJobs = Object.keys(ci.jobs).filter(name => !['quick', 'full-pending', 'full'].includes(name));
const successful = Object.fromEntries(
  Object.keys(ci.jobs).map(name => [name, { result: 'success', outputs: { run: 'true' } }]),
);
for (const action of ['opened', 'synchronize', 'reopened']) {
  const quick = event('pull_request', action);
  assert.equal(evaluate(conditionOf(ci, 'quick'), quick), true);
  assert.equal(evaluate(conditionOf(ci, 'full-pending'), quick), true);
  for (const name of [...fullJobs, 'full'])
    assert.equal(evaluate(conditionOf(ci, name), quick, successful), false, `${name} ran without full-ci`);
}
for (const [eventName, action, labels, label] of [
  ['pull_request', 'labeled', ['full-ci'], 'full-ci'],
  ['pull_request', 'synchronize', ['full-ci'], ''],
  ['push', '', [], ''],
  ['workflow_dispatch', '', [], ''],
] as [string, string, string[], string][]) {
  const full = event(eventName, action, labels, label);
  for (const name of [...fullJobs, 'full'])
    assert.equal(evaluate(conditionOf(ci, name), full, successful), true, `${name} missed full event`);
}
const unrelated = event('pull_request', 'labeled', ['full-ci'], 'documentation');
for (const workflow of [ci, ...other]) {
  if (workflow !== ci) {
    for (const action of ['opened', 'synchronize', 'reopened']) {
      for (const job of Object.values(workflow.jobs))
        assert.equal(
          evaluate(need(job.if, `${job.name} if`), event('pull_request', action), successful),
          false,
          `${job.name} ran without full-ci`,
        );
    }
  }
  for (const job of Object.values(workflow.jobs))
    assert.equal(
      evaluate(need(job.if, `${job.name} if`), unrelated, successful),
      false,
      `${job.name} ran on unrelated label`,
    );
  const group = need(
    workflow.concurrency.group.match(/-\$\{\{([\s\S]*)\}\}/)?.[1],
    `${workflow.concurrency.group} expression`,
  );
  assert.equal(evaluate(group, unrelated), 123, 'unrelated label must have its own run-id group');
  assert.equal(evaluate(workflow.concurrency['cancel-in-progress'], unrelated), false);
  assert.equal(evaluate(group, event('pull_request', 'synchronize', ['full-ci'])), 'pr-42');
}
assert.deepEqual(
  [...needsOf('full')].sort(),
  Object.keys(ci.jobs)
    .filter(name => name !== 'full')
    .sort(),
  'verdict must need every job',
);
assert.ok(conditionOf(ci, 'full').includes('always()'), 'full verdict must run after failed or skipped dependencies');
assert.ok(
  evaluate(runsOnExpression('quick'), event('pull_request', 'synchronize')).includes(
    'nscloud-ubuntu-24.04-amd64-8x16-with-cache',
  ),
);
assert.ok(evaluate(runsOnExpression('quick'), event('push')).includes('nscloud-ubuntu-24.04-amd64-4x8-with-cache'));
// A dispatch picks Quick's shape so main's 4x8 can be measured on a branch; the input never moves a PR or main.
for (const [shape, pushShape] of [['8x16', '4x8']] as const) {
  const quickShape = (github: object, input: string) =>
    evaluate(runsOnExpression('quick'), github, {}, {}, { quick_shape: input });
  assert.ok(quickShape(event('workflow_dispatch'), '4x8').includes('nscloud-ubuntu-24.04-amd64-4x8-with-cache'));
  assert.ok(quickShape(event('workflow_dispatch'), shape).includes(`nscloud-ubuntu-24.04-amd64-${shape}-with-cache`));
  assert.ok(quickShape(event('push'), shape).includes(`nscloud-ubuntu-24.04-amd64-${pushShape}-with-cache`));
  assert.ok(
    quickShape(event('pull_request', 'synchronize'), '4x8').includes('nscloud-ubuntu-24.04-amd64-8x16-with-cache'),
  );
}
const dispatchShape = (input: string) => ({
  FY_CI_QUICK_PARALLEL: evaluate(
    need(
      need(
        need(jobOf(ci, 'quick').steps, "'steps' of job 'quick'").find(step => step.name === 'Run the quick set'),
        "step 'Run the quick set'",
      ).env?.FY_CI_QUICK_PARALLEL,
      'FY_CI_QUICK_PARALLEL of the quick set',
    ),
    event('workflow_dispatch'),
    {},
    {},
    { quick_shape: input },
  ),
});
assert.equal(dispatchShape('4x8').FY_CI_QUICK_PARALLEL, '3', "a 4x8 dispatch must run main's part limits");
assert.equal(dispatchShape('8x16').FY_CI_QUICK_PARALLEL, '6');
assert.ok(runsOnOf('int').includes('nscloud-ubuntu-24.04-amd64-8x16-with-cache'));
const prRunner = (name: string) =>
  evaluate(runsOnExpression(name), event('pull_request', 'synchronize', ['full-ci']), {}, {});
assert.ok(prRunner('full-gates').includes('nscloud-ubuntu-24.04-amd64-4x8-with-cache'), 'Knip needs the 4x8');
assert.ok(prRunner('compile').includes('nscloud-ubuntu-24.04-amd64-2x4-with-cache'), 'compile stays a 2x4');
// SIT is steps of compile, not a job: it runs on the files compile wrote, after the manifest is written and
// the upload steps, never a rebuild and never a download.
assert.equal(ci.jobs.sit, undefined, 'SIT is a step of compile, not a job of its own');
{
  const stepNames = need(jobOf(ci, 'compile').steps, "'steps' of job 'compile'").map(step => step.name);
  const at = (name: string) => {
    const index = stepNames.indexOf(name);
    assert.ok(index >= 0, `compile has no step '${name}'`);
    return index;
  };
  assert.ok(at('List the binaries') < at('Upload binaries (retry)'), 'the manifest is written before the upload');
  assert.ok(at('Upload binaries (retry)') < at('Check the binaries against their manifest'));
  assert.ok(at('Check the binaries against their manifest') < at('Run SIT'), 'SIT runs on checked, shipped bytes');
  assert.equal(stepNames.includes('Download compiled binaries'), false, 'SIT must not download the artifact again');
}
assert.equal(evaluate(runsOnExpression('full-gates'), event('push'), {}, {}), 'ubuntu-latest');
assert.ok(
  jobOf(ci, 'full').permissions?.['pull-requests'] === 'read',
  'the verdict reads the PR head and labels: it needs pull-requests: read',
);

const judge = (needs: object, macos = '', eventName = 'pull_request', strictSwitch = '') =>
  Bun.spawnSync(['./scripts/ci/full-status.sh', 'judge'], {
    env: {
      ...process.env,
      NEEDS: JSON.stringify(needs),
      MACOS_SMOKE: macos,
      EVENT_NAME: eventName,
      FY_STRICT_GUARANTEES_BLOCKING: strictSwitch,
      GITHUB_STEP_SUMMARY: '/dev/null',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  }).exitCode;
assert.equal(judge(successful), 0);
for (const name of needsOf('full')) {
  for (const result of ['failure', 'cancelled', 'skipped']) {
    assert.notEqual(judge({ ...successful, [name]: { result } }), 0, `gate accepted ${name} ${result}`);
  }
}
// The strict-guarantee report is report-only while the ONE switch (workflow env) is 'false': the job's own setup steps
// or timeout cannot turn Full CI red then. At 'true' it is judged like every other job, and only it is relaxed.
assert.equal(ci.env?.FY_STRICT_GUARANTEES_BLOCKING, 'false', 'the strict report ships non-blocking');
assert.equal(
  jobOf(ci, 'strict-guarantees').env,
  undefined,
  'the switch lives at workflow level, one value for both readers',
);
for (const result of ['failure', 'cancelled', 'skipped']) {
  const needs = { ...successful, 'strict-guarantees': { result } };
  assert.equal(judge(needs, '', 'pull_request', 'false'), 0, `non-blocking switch rejected a ${result} strict report`);
  assert.notEqual(judge(needs, '', 'pull_request', 'true'), 0, `blocking switch accepted a ${result} strict report`);
  assert.notEqual(judge({ ...needs, quick: { result: 'failure' } }, '', 'pull_request', 'false'), 0);
}
assert.equal(judge(successful, '', 'pull_request', 'true'), 0);
const darwinSkipped = { ...successful, 'smoke-darwin': { result: 'skipped' } };
assert.equal(judge(darwinSkipped, 'skip'), 0);
assert.equal(judge(darwinSkipped, 'SKIP'), 0);
assert.notEqual(judge({ ...darwinSkipped, compile: { result: 'failure' } }, 'skip'), 0);
assert.equal(judge({ ...successful, 'full-pending': { result: 'skipped' } }, '', 'push'), 0);

const temporary = mkdtempSync(join(tmpdir(), 'ci-parts-'));
try {
  // Quick's format part runs treefmt in a scratch snapshot that has no `node_modules`. Every workspace tool
  // treefmt runs from there (nix/fmt.nix) must be linked into that snapshot, or Quick fails in CI with exit 127
  // (#1525 made Biome the formatter) instead of here.
  const formatters = new Set(
    [...readFileSync('nix/fmt.nix', 'utf8').matchAll(/\.\/node_modules\/\.bin\/([\w-]+)/g)].map(match => match[1]),
  );
  assert.ok(formatters.size > 0, 'nix/fmt.nix runs no workspace tool: the snapshot link contract below is stale');
  const quickPart = readFileSync('scripts/ci/quick-part.sh', 'utf8');
  for (const tool of formatters)
    assert.ok(
      quickPart.includes(`"\${snapshot}/node_modules/.bin/${tool}"`),
      `Quick's format snapshot must link node_modules/.bin/${tool}, which nix/fmt.nix runs`,
    );

  // Exercise the actual side-effect decisions against a fake GitHub CLI; never write to GitHub.
  const gh = join(temporary, 'gh');
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$CI_STATUS_CALLS"
case "$*" in
*'/pulls/'*) printf '%s\\n' "$CI_CURRENT_HEAD" ;;
*'/actions/runs?'*) printf '%s\\n' "$CI_NEWER_RUN" ;;
*'/labels --jq'*) printf '%s\\n' true ;;
esac
`,
  );
  chmodSync(gh, 0o755);
  const failed = { ...successful, int: { result: 'failure' } };
  const statusCalls = (needs: object, currentHead = 'tested-head', eventName = 'pull_request', newerRun = false) => {
    const calls = join(temporary, 'gh-calls');
    writeFileSync(calls, '');
    const result = Bun.spawnSync(['./scripts/ci/full-status.sh', 'verdict'], {
      env: {
        ...process.env,
        PATH: `${temporary}:${process.env.PATH}`,
        NEEDS: JSON.stringify(needs),
        EVENT_NAME: eventName,
        CI_NEWER_RUN: String(newerRun),
        GITHUB_WORKFLOW: 'CI',
        PR_NUMBER: '42',
        HEAD_SHA: 'tested-head',
        CI_CURRENT_HEAD: currentHead,
        CI_STATUS_CALLS: calls,
        GITHUB_REPOSITORY: 'fixture/repo',
        GITHUB_RUN_ID: '1',
        GITHUB_STEP_SUMMARY: '/dev/null',
        MACOS_SMOKE: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { code: result.exitCode, calls: readFileSync(calls, 'utf8') };
  };
  assert.ok(statusCalls(failed).calls.includes('--method DELETE repos/fixture/repo/issues/42/labels/full-ci'));
  // A job cancelled while the PR head is still the tested SHA is a timeout or a manual cancel: a real failure.
  assert.ok(statusCalls({ ...failed, smoke: { result: 'cancelled' } }).calls.includes('--method DELETE'));
  assert.ok(statusCalls({ ...successful, int: { result: 'cancelled' } }).calls.includes('--method DELETE'));
  // A superseding push changes the head, so neither failed nor cancelled jobs touch the new head's label.
  assert.ok(!statusCalls(failed, 'newer-head').calls.includes('--method DELETE'));
  assert.ok(
    !statusCalls({ ...successful, int: { result: 'cancelled' } }, 'newer-head').calls.includes('--method DELETE'),
  );
  // Re-adding full-ci on the SAME head cancels the old run: its cancelled job is ignored when a newer run
  // exists for this head SHA, so the label that was just re-added stays. A real failure still counts.
  const cancelledNeeds = { ...successful, int: { result: 'cancelled' } };
  assert.ok(!statusCalls(cancelledNeeds, 'tested-head', 'pull_request', true).calls.includes('--method DELETE'));
  assert.ok(
    statusCalls(cancelledNeeds, 'tested-head', 'pull_request', true).calls.includes(
      'actions/runs?head_sha=tested-head',
    ),
  );
  assert.ok(statusCalls(failed, 'tested-head', 'pull_request', true).calls.includes('--method DELETE'));
  assert.ok(statusCalls(cancelledNeeds, 'tested-head', 'pull_request', false).calls.includes('--method DELETE'));
  // `Full CI` is posted by a pull request's own run only: main and a dispatch on a PR branch only exit with the
  // verdict, so a late green dispatch can never replace a red pull_request status on the head.
  for (const eventName of ['push', 'workflow_dispatch']) {
    for (const needs of [successful, failed]) {
      const posted = statusCalls(needs, 'tested-head', eventName);
      assert.ok(!posted.calls.includes('/statuses/'), `${eventName} must not post a Full CI status`);
      assert.ok(!posted.calls.includes('--method'), `${eventName} must not write to GitHub at all`);
      assert.equal(posted.code, needs === successful ? 0 : 1);
    }
  }
  assert.ok(statusCalls(successful).calls.includes('repos/fixture/repo/statuses/tested-head'));
  // Skipped jobs alone are not a failure of this proof.
  assert.ok(!statusCalls({ ...successful, int: { result: 'skipped' } }).calls.includes('--method DELETE'));
  assert.equal(statusCalls(successful).code, 0);

  const configured = Bun.YAML.parse(readFileSync('.pre-commit-config.yaml', 'utf8')) as {
    repos: { hooks: { id: string; stages?: string[] }[] }[];
  };
  // The union below filters by stages exactly as gate-hooks.ts does, so an unknown stage spelling (a
  // legacy alias such as 'commit') would drop a hook from both sides unseen: refuse any stage not known.
  const knownStages = new Set([
    'pre-commit',
    'pre-push',
    'commit-msg',
    'manual',
    'prepare-commit-msg',
    'post-checkout',
  ]);
  for (const hook of configured.repos.flatMap(repo => repo.hooks))
    for (const stage of hook.stages ?? [])
      assert.ok(knownStages.has(stage), `hook ${hook.id} has unknown stage ${stage}`);
  const hooks = (mode: string) =>
    Bun.spawnSync(['bun', 'scripts/ci/gate-hooks.ts', mode], { stdout: 'pipe' }).stdout.toString().trim().split('\n');
  const quickHooks = hooks('quick');
  const fullHooks = hooks('full');
  assert.deepEqual(fullHooks.sort(), ['a-deadcode', 'a-deadcode-production'].sort());
  const expectedHooks = configured.repos
    .flatMap(repo => repo.hooks)
    .filter(hook => hook.id !== 'treefmt' && (hook.stages === undefined || hook.stages.includes('pre-commit')))
    .map(hook => hook.id)
    .sort();
  assert.deepEqual(
    [...quickHooks, ...fullHooks].sort(),
    expectedHooks,
    'Quick + Full must execute every non-format pre-commit hook exactly once',
  );
  const runner = join(temporary, 'part.sh');
  writeFileSync(runner, '#!/usr/bin/env bash\nset -euo pipefail\nprintf "part %s\\n" "$1"\n[[ $1 != bad ]]\n');
  const logs = join(temporary, 'logs');
  const result = Bun.spawnSync(['./scripts/ci/parallel.sh', logs, '2', 'bash', runner, '--', 'bad', 'good', 'last'], {
    env: { ...process.env, GITHUB_STEP_SUMMARY: '/dev/null' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  assert.equal(result.exitCode, 1, 'one failed part must fail the set');
  const rows = readFileSync(join(logs, 'results.tsv'), 'utf8');
  for (const name of ['bad', 'good', 'last'])
    assert.ok(
      rows.includes(`${name}\t${name === 'bad' ? '1' : '0'}\t`),
      `${name} must run and report after a sibling failure`,
    );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
console.log('✅ CI sets: label events, concurrency, complete verdict, optional skips and run-all failures hold');
