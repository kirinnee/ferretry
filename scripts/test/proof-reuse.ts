// scripts/ci/proof-reuse.sh against fixtures: one YES, and one NO per rule (a to f), plus an API error at each
// call. `gh` and `git` are stubs on PATH; nothing reaches GitHub. The rule list is in the script's header.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = 'fixture/repo';
const sha = 'a'.repeat(40);
const tree = '1'.repeat(40);
const head = 'b'.repeat(40);
const runUrl = `https://github.com/${repo}/actions/runs/4242`;

type Fixture = {
  pulls: unknown;
  statuses: unknown;
  run: unknown;
  /** Names of the calls (`pulls`, `statuses`, `run`) whose API answer is an error. */
  failing: string[];
  tree: string | null;
  env: Record<string, string>;
};
const pull = { number: 7, merged_at: '2026-01-01T00:00:00Z', base: { ref: 'main' }, head: { sha: head } };
const status = (over: Record<string, unknown> = {}) => ({
  id: 20,
  context: 'Full CI',
  state: 'success',
  creator: { login: 'github-actions[bot]' },
  description: `quick checks and the full set passed on this commit; tree ${tree}`,
  target_url: runUrl,
  ...over,
});
const base = (): Fixture => ({
  pulls: [pull],
  statuses: [
    status({ id: 10, state: 'pending', description: 'full set not run on this commit: add the full-ci label' }),
    status(),
  ],
  run: { path: '.github/workflows/ci.yaml', event: 'pull_request', head_sha: head, conclusion: 'success' },
  failing: [],
  tree,
  env: {},
});

const root = mkdtempSync(join(tmpdir(), 'proof-reuse-'));
const bin = join(root, 'bin');
mkdirSync(bin);
writeFileSync(
  join(bin, 'gh'),
  `#!/usr/bin/env bash
set -euo pipefail
[[ $1 == api ]] || exit 64
case "$2" in
*"/commits/$FIXTURE_SHA/pulls") name=pulls ;;
*"/commits/$FIXTURE_HEAD/statuses"*) name=statuses ;;
*"/actions/runs/4242") name=run ;;
*) echo "unexpected gh call: $*" >&2; exit 64 ;;
esac
printf '%s\\n' "$name" >>"$FIXTURE_CALLS"
[[ ! -e "$FIXTURE_DIR/$name.fail" ]] || { echo "HTTP 500" >&2; exit 1; }
cat "$FIXTURE_DIR/$name.json"
`,
);
writeFileSync(
  join(bin, 'git'),
  `#!/usr/bin/env bash
[[ $1 == rev-parse && $2 == "$FIXTURE_SHA^{tree}" && -n \${FIXTURE_TREE:-} ]] || exit 128
printf '%s\\n' "$FIXTURE_TREE"
`,
);
chmodSync(join(bin, 'gh'), 0o755);
chmodSync(join(bin, 'git'), 0o755);

let counter = 0;
const decide = (fixture: Fixture) => {
  const dir = join(root, `case-${++counter}`);
  mkdirSync(dir);
  const files: [string, unknown][] = [
    ['pulls', fixture.pulls],
    ['statuses', fixture.statuses],
    ['run', fixture.run],
  ];
  for (const [name, value] of files) writeFileSync(join(dir, `${name}.json`), JSON.stringify(value));
  for (const name of fixture.failing) writeFileSync(join(dir, `${name}.fail`), '');
  const output = join(dir, 'output');
  const summary = join(dir, 'summary');
  const calls = join(dir, 'calls');
  for (const file of [output, summary, calls]) writeFileSync(file, '');
  const result = Bun.spawnSync(['./scripts/ci/proof-reuse.sh'], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: process.env.HOME ?? root,
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: sha,
      GITHUB_REPOSITORY: repo,
      GITHUB_SERVER_URL: 'https://github.com',
      MACOS_SMOKE: 'skip',
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      FIXTURE_DIR: dir,
      FIXTURE_SHA: sha,
      FIXTURE_HEAD: head,
      FIXTURE_CALLS: calls,
      FIXTURE_TREE: fixture.tree ?? '',
      ...fixture.env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = readFileSync(output, 'utf8');
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    summary: readFileSync(summary, 'utf8'),
    proved: /^proved=(.*)$/m.exec(out)?.[1],
    proof: /^proof=(.*)$/m.exec(out)?.[1],
    calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean),
  };
};
const mutate = (change: (fixture: Fixture) => void): Fixture => {
  const fixture = base();
  change(fixture);
  return fixture;
};

try {
  // YES: every rule holds.
  const yes = decide(base());
  assert.equal(yes.code, 0);
  assert.equal(yes.proved, 'true');
  assert.equal(yes.proof, runUrl);
  const line = `Proof reuse: YES - tree ${tree} passed the full set in ${runUrl} (PR #7 head ${head})`;
  assert.ok(yes.stdout.includes(line), 'the decision goes to the job log');
  assert.ok(yes.summary.includes(line), 'the decision goes to the job summary');
  for (const rule of ['a.', 'b.', 'c.', 'd.', 'e.', 'f.'])
    assert.ok(yes.summary.includes(`- ${rule} `), `rule ${rule} is printed`);
  // GitHub compares variables case-insensitively: `SKIP` skips the darwin smoke too.
  assert.equal(decide(mutate(f => (f.env.MACOS_SMOKE = 'SKIP'))).proved, 'true');
  // The newest status wins by id, whichever order the API lists them in.
  assert.equal(decide(mutate(f => (f.statuses = [...(f.statuses as unknown[])].reverse()))).proved, 'true');

  // NO: each case names its rule, writes proved=false and the reason, and exits 0 (every job then runs).
  const no = (name: string, fixture: Fixture, reason: RegExp) => {
    const got = decide(fixture);
    assert.equal(got.code, 0, `${name}: a NO is a decision, not a crash`);
    assert.equal(got.proved, 'false', `${name}: must not reuse the proof`);
    assert.equal(got.proof, '', `${name}: no proof URL`);
    assert.match(got.stdout, /Proof reuse: NO - .*Every job runs\./, `${name}: says NO and what happens`);
    assert.match(got.stdout, reason, `${name}: says why`);
    assert.ok(got.summary.includes('Proof reuse: NO'), `${name}: the summary says NO too`);
    return got;
  };

  // a. only a push to main.
  for (const [eventName, ref] of [
    ['pull_request', 'refs/pull/7/merge'],
    ['workflow_dispatch', 'refs/heads/main'],
    ['push', 'refs/heads/feature'],
    ['push', 'refs/tags/v1.0.0'],
    ['', ''],
  ] as const) {
    const got = no(
      `a ${eventName} ${ref}`,
      mutate(f => ((f.env.GITHUB_EVENT_NAME = eventName), (f.env.GITHUB_REF = ref))),
      /not a push to refs\/heads\/main/,
    );
    assert.deepEqual(got.calls, [], 'a: nothing is asked of GitHub off main');
  }
  // b. only with the darwin smoke switched off.
  for (const value of ['', 'other', 'skipped', 'false'])
    no(
      `b ${value}`,
      mutate(f => (f.env.MACOS_SMOKE = value)),
      /vars\.MACOS_SMOKE is '.*', not 'skip'/,
    );
  // c. the push's tree must be readable.
  no(
    'c git fails',
    mutate(f => (f.tree = null)),
    /cannot read the tree/,
  );
  no(
    'c not a hash',
    mutate(f => (f.tree = 'not-a-tree')),
    /not a 40-hex object/,
  );
  no(
    'c bad sha',
    mutate(f => (f.env.GITHUB_SHA = 'HEAD')),
    /GITHUB_SHA 'HEAD' is not a 40-hex/,
  );
  // d. exactly one merged pull request into main.
  no(
    'd api error',
    mutate(f => f.failing.push('pulls')),
    /API error listing the pull requests/,
  );
  no(
    'd no pull request',
    mutate(f => (f.pulls = [])),
    /belongs to 0 pull requests/,
  );
  no(
    'd not merged',
    mutate(f => (f.pulls = [{ ...pull, merged_at: null }])),
    /belongs to 0 pull requests/,
  );
  no(
    'd other base',
    mutate(f => (f.pulls = [{ ...pull, base: { ref: 'release' } }])),
    /belongs to 0 pull requests/,
  );
  no(
    'd two merged',
    mutate(f => (f.pulls = [pull, { ...pull, number: 8 }])),
    /belongs to 2 pull requests/,
  );
  no(
    'd no head sha',
    mutate(f => (f.pulls = [{ ...pull, head: {} }])),
    /has no 40-hex head SHA/,
  );
  no(
    'd short head sha',
    mutate(f => (f.pulls = [{ ...pull, head: { sha: 'abc' } }])),
    /has no 40-hex head SHA/,
  );
  no(
    'd not json',
    mutate(f => (f.pulls = 'oops')),
    /belongs to|could not be read/,
  );
  // The one merged pull request wins over an open one that also holds the commit.
  assert.equal(decide(mutate(f => (f.pulls = [pull, { ...pull, number: 9, merged_at: null }]))).proved, 'true');
  // e. the newest Full CI status on that head.
  no(
    'e api error',
    mutate(f => f.failing.push('statuses')),
    /API error listing the statuses/,
  );
  no(
    'e none',
    mutate(f => (f.statuses = [])),
    /has no Full CI status/,
  );
  no(
    'e other context only',
    mutate(f => (f.statuses = [status({ context: 'ci/other' })])),
    /has no Full CI status/,
  );
  no(
    'e pending',
    mutate(f => (f.statuses = [status({ state: 'pending' })])),
    /is 'pending', not success/,
  );
  no(
    'e failure',
    mutate(f => (f.statuses = [status({ state: 'failure' })])),
    /is 'failure', not success/,
  );
  no(
    'e older success, newer failure',
    mutate(f => (f.statuses = [status({ id: 30, state: 'failure' }), status({ id: 20 })])),
    /is 'failure', not success/,
  );
  no(
    'e older success, newer pending (listed last)',
    mutate(f => (f.statuses = [status({ id: 20 }), status({ id: 30, state: 'pending' })])),
    /is 'pending', not success/,
  );
  no(
    'e other creator',
    mutate(f => (f.statuses = [status({ creator: { login: 'someone' } })])),
    /posted by 'someone', not github-actions\[bot\]/,
  );
  no(
    'e no creator',
    mutate(f => (f.statuses = [status({ creator: null })])),
    /posted by '', not github-actions\[bot\]/,
  );
  no(
    'e no tree in the description',
    mutate(f => (f.statuses = [status({ description: 'quick checks and the full set passed on this commit' })])),
    /names no tested tree/,
  );
  no(
    'e null description',
    mutate(f => (f.statuses = [status({ description: null })])),
    /names no tested tree/,
  );
  no(
    'e short tree',
    mutate(f => (f.statuses = [status({ description: 'passed; tree 1234' })])),
    /names no tested tree/,
  );
  no(
    'e other tree',
    mutate(f => (f.statuses = [status({ description: `passed; tree ${'2'.repeat(40)}` })])),
    /tested tree 2{40} but this push is tree 1{40}/,
  );
  no(
    'e tree not at the end',
    mutate(f => (f.statuses = [status({ description: `passed; tree ${tree} extra` })])),
    /names no tested tree/,
  );
  // f. the status must point at a successful pull_request run of ci.yaml on that head.
  no(
    'f other repository',
    mutate(f => (f.statuses = [status({ target_url: 'https://github.com/other/repo/actions/runs/4242' })])),
    /is not a run of fixture\/repo/,
  );
  no(
    'f not a run url',
    mutate(f => (f.statuses = [status({ target_url: `${runUrl}/attempts/2` })])),
    /not a plain run URL/,
  );
  no(
    'f no target',
    mutate(f => (f.statuses = [status({ target_url: null })])),
    /is not a run of fixture\/repo/,
  );
  no(
    'f api error',
    mutate(f => f.failing.push('run')),
    /API error reading run 4242/,
  );
  no(
    'f other workflow',
    mutate(f => (f.run = { ...(f.run as object), path: '.github/workflows/release.yaml' })),
    /is not a successful pull_request run of \.github\/workflows\/ci\.yaml/,
  );
  no(
    'f path with a ref suffix',
    mutate(f => (f.run = { ...(f.run as object), path: '.github/workflows/ci.yaml@refs/heads/x' })),
    /is not a successful pull_request run/,
  );
  no(
    'f other event',
    mutate(f => (f.run = { ...(f.run as object), event: 'workflow_dispatch' })),
    /event=workflow_dispatch/,
  );
  no(
    'f push event',
    mutate(f => (f.run = { ...(f.run as object), event: 'push' })),
    /event=push/,
  );
  no(
    'f other head',
    mutate(f => (f.run = { ...(f.run as object), head_sha: 'c'.repeat(40) })),
    /is not a successful pull_request run/,
  );
  no(
    'f failed run',
    mutate(f => (f.run = { ...(f.run as object), conclusion: 'failure' })),
    /conclusion=failure/,
  );
  no(
    'f unfinished run',
    mutate(f => (f.run = { ...(f.run as object), conclusion: null })),
    /conclusion=null/,
  );
  no(
    'f missing field',
    mutate(f => (f.run = { path: '.github/workflows/ci.yaml', event: 'pull_request' })),
    /is not a successful pull_request run/,
  );
  no(
    'f not json',
    mutate(f => (f.run = 'oops')),
    /could not be read|is not a successful/,
  );

  // The script is read-only: every call it makes is a GET of one of the three documents.
  assert.deepEqual(yes.calls, ['pulls', 'statuses', 'run']);
  assert.ok(
    !readFileSync('scripts/ci/proof-reuse.sh', 'utf8').includes('--method'),
    'proof-reuse.sh never writes to GitHub',
  );
  assert.ok(existsSync('scripts/ci/proof-reuse.sh'));
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('✅ Proof reuse: the YES case and a NO for every rule hold');
