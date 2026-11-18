import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repository = join(import.meta.dir, '../..');
const scratch: string[] = [];
afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

/** A throwaway checkout holding only what the gate reads: the workflows and `.releaserc.yaml`. */
function checkout(mutate: (path: (file: string) => string) => void = () => {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'release-guards-'));
  scratch.push(directory);
  mkdirSync(join(directory, '.github'), { recursive: true });
  cpSync(join(repository, '.github/workflows'), join(directory, '.github/workflows'), { recursive: true });
  cpSync(join(repository, '.releaserc.yaml'), join(directory, '.releaserc.yaml'));
  mutate(file => join(directory, file));
  return directory;
}

function edit(file: string, from: string | RegExp, to: string): void {
  const before = readFileSync(file, 'utf8');
  const after = before.replace(from, to);
  if (after === before) throw new Error(`the test's edit did not apply to ${file}`);
  writeFileSync(file, after);
}

function gate(directory: string) {
  const result = Bun.spawnSync(['bash', join(repository, 'scripts/validate/release-guards.sh'), '--root', directory], {
    env: process.env,
  });
  return { status: result.exitCode, err: result.stderr.toString(), out: result.stdout.toString() };
}

describe('scripts/validate/release-guards.sh', () => {
  test('this checkout passes', () => {
    expect(gate(checkout())).toMatchObject({ status: 0 });
  });

  test('a preview deploy that falls back to the repository-level Cloudflare token is refused', () => {
    const result = gate(
      checkout(p =>
        edit(
          p('.github/workflows/pwa-pages-v5.yaml'),
          /secrets\.CLOUDFLARE_PAGES_V5_API_TOKEN \}\}\n          CLOUDFLARE_ACCOUNT_ID/u,
          'secrets.CLOUDFLARE_API_TOKEN }}\n          CLOUDFLARE_ACCOUNT_ID',
        ),
      ),
    );
    expect(result.status).toBe(1);
    expect(result.err).toContain('must not read the repository-level CLOUDFLARE_API_TOKEN');
  });

  test('MAJOR-4 a CD job that is not behind main-only (even a new publishing job) is refused', () => {
    const result = gate(
      checkout(p =>
        writeFileSync(
          p('.github/workflows/cd.yaml'),
          readFileSync(p('.github/workflows/cd.yaml'), 'utf8') +
            '  extra-publish:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo publish\n',
        ),
      ),
    );
    expect(result.status).toBe(1);
    expect(result.err).toContain('not behind main-only');
    expect(result.err).toContain('extra-publish');
  });

  test('a CD compile that no longer waits for the main-only proof is refused', () => {
    const result = gate(checkout(p => edit(p('.github/workflows/cd.yaml'), '    needs: main-only\n', '')));
    expect(result.status).toBe(1);
    expect(result.err).toContain('job compile must need main-only');
  });

  test('a CD main-only job that stops proving ancestry is refused', () => {
    const result = gate(checkout(p => edit(p('.github/workflows/cd.yaml'), 'merge-base --is-ancestor', 'rev-parse')));
    expect(result.status).toBe(1);
    expect(result.err).toContain('ancestor of origin/main');
  });

  test('a Release job that stops repeating the branch is refused', () => {
    const result = gate(
      checkout(p =>
        edit(p('.github/workflows/release.yaml'), " && github.event.workflow_run.head_branch == 'main'", ''),
      ),
    );
    expect(result.status).toBe(1);
    expect(result.err).toContain("head_branch == 'main'");
  });

  test('a Release triggered from another branch is refused', () => {
    const result = gate(
      checkout(p => edit(p('.github/workflows/release.yaml'), 'branches: [main]', 'branches: [main, rebuild/5.0]')),
    );
    expect(result.status).toBe(1);
  });

  test('semantic-release configured for another branch is refused', () => {
    const result = gate(
      checkout(p => edit(p('.releaserc.yaml'), 'branches:\n  - main\n', 'branches:\n  - main\n  - rebuild/5.0\n')),
    );
    expect(result.status).toBe(1);
    expect(result.err).toContain('.releaserc.yaml must release main alone');
  });

  test('a secret-holding job with no main guard is refused', () => {
    const result = gate(
      checkout(p =>
        edit(
          p('.github/workflows/pwa-pages.yaml'),
          /    needs: build\n    if: github.ref == 'refs\/heads\/main'\n/,
          '    needs: build\n',
        ),
      ),
    );
    expect(result.status).toBe(1);
    expect(result.err).toContain('pwa-pages.yaml: job sign');
  });

  test('a tag trigger outside CD is refused', () => {
    const result = gate(
      checkout(p => edit(p('.github/workflows/ci.yaml'), 'on:\n  push:\n', "on:\n  push:\n    tags: ['v*']\n")),
    );
    expect(result.status).toBe(1);
    expect(result.err).toContain('is triggered by a tag');
  });

  test('a workflow other than CD and Release that names the cask is refused', () => {
    const result = gate(
      checkout(p => edit(p('.github/workflows/realworld.yaml'), 'name: ', '# git add Casks/ferretry.rb\nname: ')),
    );
    expect(result.status).toBe(1);
    expect(result.err).toContain('names Casks/');
  });

  const triggerMessage = 'triggered by pushes to rebuild/preview alone';
  const workflowPath = '.github/workflows/pwa-pages-v5.yaml';
  const triggerEdit = (branches: string) =>
    gate(checkout(p => edit(p(workflowPath), 'branches: [rebuild/preview]', `branches: [${branches}]`)));

  test('the preview is triggered by rebuild/preview and no other branch', () => {
    expect(readFileSync(join(repository, workflowPath), 'utf8')).toContain('    branches: [rebuild/preview]\n');
  });

  test('the preview triggered by main is refused', () => {
    const result = triggerEdit('main');
    expect(result.status).toBe(1);
    expect(result.err).toContain(triggerMessage);
  });

  test('the preview triggered by a second branch is refused', () => {
    const result = triggerEdit('rebuild/preview, rebuild/c58-00b');
    expect(result.status).toBe(1);
    expect(result.err).toContain(triggerMessage);
  });

  test('the old triggers, a push to rebuild/5.0 or rebuild/5.0-after, are refused (a merge must not move the preview)', () => {
    for (const legacy of ['rebuild/5.0', 'rebuild/5.0-after', 'rebuild/preview, rebuild/5.0-after']) {
      const result = triggerEdit(legacy);
      expect(result.status).toBe(1);
      expect(result.err).toContain(triggerMessage);
    }
  });

  test('a preview job that stops repeating the ref is refused', () => {
    const result = gate(
      checkout(p =>
        edit(p(workflowPath), /    needs: \[gate, build\]\n    if: [^\n]*\n/, '    needs: [gate, build]\n'),
      ),
    );
    expect(result.status).toBe(1);
    expect(result.err).toContain('must open its if with');
  });

  test('a preview job that guards the old refs instead of the preview ref is refused', () => {
    for (const ref of ['rebuild/5.0', 'rebuild/5.0-after', 'main']) {
      const result = gate(
        checkout(p =>
          edit(
            p(workflowPath),
            /    needs: \[gate, build\]\n    if: github\.ref == 'refs\/heads\/rebuild\/preview'/,
            `    needs: [gate, build]\n    if: github.ref == 'refs/heads/${ref}'`,
          ),
        ),
      );
      expect(result.status).toBe(1);
      expect(result.err).toContain('must open its if with');
    }
  });

  test('a preview job whose guard lets another ref ride along is refused', () => {
    const result = gate(
      checkout(p =>
        edit(
          p(workflowPath),
          /    needs: \[gate, build\]\n    if: github\.ref == 'refs\/heads\/rebuild\/preview'/,
          "    needs: [gate, build]\n    if: github.ref == 'refs/heads/rebuild/preview' || github.ref == 'refs/heads/main'",
        ),
      ),
    );
    expect(result.status).toBe(1);
    expect(result.err).toContain('followed only by && conditions');
  });

  test('a preview job whose exact guard is followed by a top-level || is refused', () => {
    const result = gate(
      checkout(p =>
        edit(
          p(workflowPath),
          /    needs: \[gate, build\]\n    if: github\.ref == 'refs\/heads\/rebuild\/preview'/,
          "    needs: [gate, build]\n    if: github.ref == 'refs/heads/rebuild/preview' || github.event_name == 'push'",
        ),
      ),
    );
    expect(result.status).toBe(1);
    expect(result.err).toContain('followed only by && conditions');
  });

  test('a top-level || hidden after an && condition is refused, but one inside parentheses or a string is not', () => {
    const guard = "github.ref == 'refs/heads/rebuild/preview'";
    const withTail = (tail: string) =>
      gate(
        checkout(p =>
          edit(
            p(workflowPath),
            /    needs: \[gate, build\]\n    if: [^\n]*\n/,
            `    needs: [gate, build]\n    if: ${guard}${tail}\n`,
          ),
        ),
      );
    expect(withTail(" && needs.gate.outputs.deploy == 'true' || github.event_name == 'push'").status).toBe(1);
    expect(withTail(" && needs.gate.outputs.deploy == 'true' && needs.build.result == 'success'").status).toBe(0);
    expect(withTail(" && (needs.gate.outputs.deploy == 'true' || needs.gate.outputs.deploy == 'yes')").status).toBe(0);
    expect(withTail(" && needs.gate.outputs.deploy != '||'").status).toBe(0);
  });

  test('the preview keeps the never-backwards gate and deploys to the production branch whatever built it', () => {
    const workflow = readFileSync(join(repository, workflowPath), 'utf8');
    // The gate refuses a push that is not a fast-forward of the LAST DEPLOYED commit (a read-only compare), and fails on a read it cannot make.
    expect(workflow).toContain('compare/${last}...${AFTER}');
    expect(workflow).toContain('behind | diverged)');
    expect(workflow).toContain('unexpected compare status');
    // build, sign and deploy all wait on that decision.
    expect(workflow.match(/needs\.gate\.outputs\.deploy == 'true'/gu)).toHaveLength(3);
    // A deploy still goes to the Pages project's PRODUCTION alias.
    expect(workflow).toContain('--project-name=ferretry-v5 --branch=rebuild/5.0');
    expect(workflow).not.toContain('--branch=rebuild/preview');
    expect(workflow).not.toContain('--branch=${{');
  });

  describe('an older commit cannot publish after a newer one (stale-commit refusal before the deploy)', () => {
    const workflowFile = '.github/workflows/pwa-pages-v5.yaml';
    const staleStep =
      /      # Runs inside the serialised path[\s\S]*?          echo "\$\{GITHUB_SHA\} is the head of \$\{BRANCH\}: deploying it"\n/u;
    const refused = (mutate: (text: string) => string) => {
      const result = gate(
        checkout(p => {
          writeFileSync(p(workflowFile), mutate(readFileSync(p(workflowFile), 'utf8')));
        }),
      );
      expect(result.status).toBe(1);
      expect(result.err).toContain('an older commit must not publish after a newer one');
    };

    test('the workflow reads the branch head and compares it with GITHUB_SHA before wrangler pages deploy', () => {
      const text = readFileSync(join(repository, workflowFile), 'utf8');
      const deploy = text.indexOf('nix develop .#ci -c bunx wrangler pages deploy');
      const read = text.indexOf(
        'git ls-remote --exit-code --heads "https://github.com/${REPOSITORY}" "refs/heads/${BRANCH}"',
      );
      const compare = text.indexOf('${current} != "${GITHUB_SHA}"');
      expect(read).toBeGreaterThan(0);
      expect(compare).toBeGreaterThan(read);
      expect(deploy).toBeGreaterThan(compare);
      expect(text).toContain('a newer commit ${current} is on ${BRANCH}; its own run deploys it');
      // The shared non-cancelling group stays: it serialises, the check above orders.
      expect(text).toContain('group: pwa-pages-v5\n  cancel-in-progress: false');
      // The never-backwards gate before it compares with the last deployed commit.
      expect(text).toContain('compare/${last}...${AFTER}');
    });

    test('mutation: removing the stale-commit step is refused', () => {
      refused(text => {
        const next = text.replace(staleStep, '');
        if (next === text) throw new Error('the mutation did not apply');
        return next;
      });
    });

    test('mutation: moving the stale-commit step AFTER the deploy is refused', () => {
      refused(text => {
        const step = text.match(staleStep)?.[0];
        if (step === undefined) throw new Error('the stale-commit step was not found');
        const without = text.replace(step, '');
        return `${without.trimEnd()}\n${step}`;
      });
    });

    test('mutation: dropping the comparison with GITHUB_SHA is refused', () => {
      refused(text => {
        const next = text.replace('if [[ ${current} != "${GITHUB_SHA}" ]]', 'if [[ -z ${current} ]]');
        if (next === text) throw new Error('the mutation did not apply');
        return next;
      });
    });

    test('mutation: reading something other than the run branch head is refused', () => {
      refused(text => {
        const next = text.replace('"refs/heads/${BRANCH}")" || status=$?', '"refs/heads/main")" || status=$?');
        if (next === text) throw new Error('the mutation did not apply');
        return next;
      });
    });
  });

  test("a preview signing job that shares production's environment is refused", () => {
    const result = gate(
      checkout(p =>
        edit(p('.github/workflows/pwa-pages-v5.yaml'), 'environment: pwa-release-v5', 'environment: pwa-release'),
      ),
    );
    expect(result.status).toBe(1);
    expect(result.err).toContain('sign must use pwa-release-v5');
  });
});

describe('the honest wording about a 5.0 commit that can publish', () => {
  test('the gate says an older 5.0 commit would still publish if tagged, and that no agent tags', () => {
    const { out } = gate(checkout());
    expect(out).toContain('a v* tag on a 5.0 commit made before this guard would still publish');
    expect(out).toContain('no agent ever creates or pushes a tag');
  });

  test('no script claims a 5.0 commit cannot publish without the made-after qualifier', () => {
    for (const file of ['scripts/validate/release-guards.sh']) {
      const text = readFileSync(join(repository, file), 'utf8').replace(/\n#\s*/gu, ' ');
      for (const match of text.matchAll(/cannot publish from a 5\.0 commit(?! made after this guard lands)/gu))
        throw new Error(`${file}: unqualified claim at ${match.index}`);
    }
  });
});

describe('the preview gate compares the pushed commit with the LAST DEPLOYED commit (not event.before)', () => {
  const workflowFile = join(repository, '.github/workflows/pwa-pages-v5.yaml');
  const text = readFileSync(workflowFile, 'utf8');
  const section = text.slice(text.indexOf('      - name: Apply the never-backwards rule'), text.indexOf('\n  build:'));
  const script = (section.split('        run: |\n')[1] ?? '')
    .split('\n')
    .map(line => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
  const [A, B, C] = ['1', '2', '3'].map(digit => digit.repeat(40)) as [string, string, string];

  type Run = { id: number; number: number; sha: string; deployJob: 'success' | 'skipped' | 'failure' };

  /**
   * Runs the workflow's own gate script with a fake `gh` that answers only the three reads it makes (runs of the
   * workflow, jobs of a run, compare), through the real `--jq` filters, from a fixture. `compare` maps "<last>...<after>"
   * to a status; a pair not in it is an unreadable compare (the fake exits 1).
   */
  function runGate(spec: {
    runs: readonly Run[];
    compare: Record<string, string>;
    after: string;
    runId?: number;
    deleted?: boolean;
  }) {
    const directory = mkdtempSync(join(tmpdir(), 'preview-gate-'));
    scratch.push(directory);
    writeFileSync(
      join(directory, 'runs.json'),
      JSON.stringify({
        workflow_runs: spec.runs.map(run => ({ id: run.id, run_number: run.number, head_sha: run.sha })),
      }),
    );
    for (const run of spec.runs) {
      writeFileSync(
        join(directory, `jobs-${String(run.id)}.json`),
        JSON.stringify({
          jobs: [
            { name: 'Does this ref feed the preview', conclusion: 'success' },
            { name: 'Deploy PWA', conclusion: run.deployJob },
          ],
        }),
      );
    }
    for (const [pair, status] of Object.entries(spec.compare)) {
      writeFileSync(join(directory, `compare-${pair}.json`), JSON.stringify({ status }));
    }
    writeFileSync(
      join(directory, 'gh'),
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'url=""; filter=""',
        'while (($#)); do case "$1" in api|--paginate) ;; --jq) shift; filter="$1" ;; *) [[ -z $url ]] && url="$1" ;; esac; shift; done',
        'dir="$(dirname "$0")"',
        'case "$url" in',
        '  */actions/workflows/pwa-pages-v5.yaml/runs*) file="${dir}/runs.json" ;;',
        '  */actions/runs/*/jobs) id="${url#*/actions/runs/}"; file="${dir}/jobs-${id%/jobs}.json" ;;',
        '  */compare/*) file="${dir}/compare-${url#*/compare/}.json" ;;',
        '  *) echo "unexpected gh url: ${url}" >&2; exit 2 ;;',
        'esac',
        '[[ -f ${file} ]] || { echo "no fixture for ${url}" >&2; exit 1; }',
        'jq -r "${filter}" "${file}"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const output = join(directory, 'github-output');
    writeFileSync(output, '');
    const result = Bun.spawnSync(['bash', '-c', script], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        GITHUB_OUTPUT: output,
        GH_TOKEN: 'unused',
        DELETED: spec.deleted === true ? 'true' : 'false',
        AFTER: spec.after,
        REPOSITORY: 'example/repo',
        RUN_ID: String(spec.runId ?? 99),
      },
    });
    return {
      status: result.exitCode,
      err: result.stderr.toString(),
      deploy: readFileSync(output, 'utf8').trim(),
    };
  }

  /** A -> B -> C deployed in turn; C is live. Then C was force-rewound to A: that run deployed nothing. */
  const history: Run[] = [
    { id: 1, number: 1, sha: A, deployJob: 'success' },
    { id: 2, number: 2, sha: B, deployJob: 'success' },
    { id: 3, number: 3, sha: C, deployJob: 'success' },
    { id: 4, number: 4, sha: A, deployJob: 'skipped' },
  ];

  test('the first deploy ever (no earlier run) follows the push', () => {
    const result = runGate({ runs: [], compare: {}, after: A });
    expect(result).toMatchObject({ status: 0, deploy: 'deploy=true' });
  });

  test('only a run whose Deploy PWA job succeeded counts: a green run with a skipped or failed deploy is not live', () => {
    const runs: Run[] = [
      { id: 1, number: 1, sha: B, deployJob: 'success' },
      { id: 2, number: 2, sha: A, deployJob: 'skipped' },
      { id: 3, number: 3, sha: C, deployJob: 'failure' },
    ];
    // B is the live commit: C (failed) and A (skipped) are ignored.
    expect(runGate({ runs, compare: { [`${B}...${C}`]: 'ahead' }, after: C }).deploy).toBe('deploy=true');
    expect(runGate({ runs, compare: { [`${B}...${A}`]: 'behind' }, after: A }).deploy).toBe('deploy=false');
  });

  test('after a refused force-rewind C -> A, a forward push A -> B does NOT deploy B (older than the live C)', () => {
    const result = runGate({ runs: history, compare: { [`${C}...${B}`]: 'behind' }, after: B });
    expect(result).toMatchObject({ status: 0, deploy: 'deploy=false' });
    expect(result.err).toBe('');
  });

  test('a force-rewind to A itself deploys nothing, and a recreated ref at A (before = zeros) deploys nothing either', () => {
    // The gate does not read event.before at all, so a created ref, a force-push and a recreate are the same question.
    expect(runGate({ runs: history, compare: { [`${C}...${A}`]: 'behind' }, after: A }).deploy).toBe('deploy=false');
    expect(text).not.toContain('github.event.before }}');
    expect(script).not.toContain('BEFORE');
  });

  test('a diverged commit deploys nothing; a descendant of the live commit deploys; the live commit again is a no-op', () => {
    expect(runGate({ runs: history, compare: { [`${C}...${B}`]: 'diverged' }, after: B }).deploy).toBe('deploy=false');
    expect(runGate({ runs: history, compare: { [`${C}...${A}`]: 'ahead' }, after: A }).deploy).toBe('deploy=true');
    expect(runGate({ runs: history, compare: { [`${C}...${C}`]: 'identical' }, after: C }).deploy).toBe('deploy=false');
  });

  test('this run is never its own reference (a re-run of the only deploy compares with nothing, not with itself)', () => {
    const runs: Run[] = [{ id: 7, number: 7, sha: A, deployJob: 'success' }];
    expect(runGate({ runs, compare: {}, after: A, runId: 7 })).toMatchObject({ status: 0, deploy: 'deploy=true' });
  });

  test('a deleted ref deploys nothing', () => {
    expect(runGate({ runs: history, compare: {}, after: A, deleted: true })).toMatchObject({
      status: 0,
      deploy: 'deploy=false',
    });
  });

  test('a compare it cannot read, or a status it does not know, fails the job instead of guessing', () => {
    const unreadable = runGate({ runs: history, compare: {}, after: B });
    expect(unreadable.status).not.toBe(0);
    expect(unreadable.deploy).toBe('');
    const unknown = runGate({ runs: history, compare: { [`${C}...${B}`]: 'mystery' }, after: B });
    expect(unknown.status).toBe(1);
    expect(unknown.err).toContain('unexpected compare status');
    expect(unknown.deploy).toBe('');
  });

  test('there is no manual trigger, and the gate may read actions', () => {
    expect(text).not.toMatch(/^  workflow_dispatch:/mu);
    expect(text).toContain('      actions: read\n');
  });

  test('mutation: a workflow with a workflow_dispatch trigger is refused', () => {
    const result = gate(
      checkout(p =>
        edit(
          p('.github/workflows/pwa-pages-v5.yaml'),
          '    branches: [rebuild/preview]\n',
          '    branches: [rebuild/preview]\n  workflow_dispatch:\n',
        ),
      ),
    );
    expect(result.status).toBe(1);
    expect(result.err).toContain('only by a push');
  });
});
