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
    // The gate refuses a push that is not a fast-forward of the LIVE commit, read from the site's signed record (a read-only compare), and fails on a read it cannot make.
    expect(workflow).toContain('compare/${live}...${AFTER}');
    expect(workflow).toContain('behind | diverged)');
    expect(workflow).toContain('unexpected compare status');
    // build, sign, project, verify and deploy all wait on that decision.
    expect(workflow.match(/needs\.gate\.outputs\.deploy == 'true'/gu)).toHaveLength(5);
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
      const deploy = text.indexOf('wrangler pages deploy "${RUNNER_TEMP}/dist"');
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
      expect(text).toContain('compare/${live}...${AFTER}');
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

describe('the preview gate compares the pushed commit with what the LIVE site says is live', () => {
  const workflowFile = join(repository, '.github/workflows/pwa-pages-v5.yaml');
  const text = readFileSync(workflowFile, 'utf8');
  const section = text.slice(text.indexOf('      - name: Apply the never-backwards rule'), text.indexOf('\n  build:'));
  const script = (section.split('        run: |\n')[1] ?? '')
    .split('\n')
    .map(line => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
  const [A, B, C] = ['1', '2', '3'].map(digit => digit.repeat(40)) as [string, string, string];

  type Live = {
    /** What the site answers for each file: a status and a body, or `unreachable` (curl fails). */
    manifest?: { status: number; commit?: string } | 'unreachable';
    signature?: { status: number } | 'unreachable';
    /** Whether scripts/ci/verify-pwa-release.sh accepts the downloaded record. */
    verifies?: boolean;
  };

  /**
   * Runs the workflow's own gate script in a throwaway checkout whose `curl`, `gh` and scripts are fakes. The fake `gh`
   * answers only `compare` (any other read, such as run history, fails the script); `compare` maps "<live>...<after>" to a
   * status, and a pair not in it is an unreadable compare.
   */
  function runGate(spec: { live: Live; compare?: Record<string, string>; after: string; deleted?: boolean }) {
    const directory = mkdtempSync(join(tmpdir(), 'preview-gate-'));
    scratch.push(directory);
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    mkdirSync(join(directory, 'scripts/ci'), { recursive: true });
    writeFileSync(join(directory, 'scripts/ci/hosted-app-origin.sh'), '#!/bin/sh\necho https://preview.example\n', {
      mode: 0o755,
    });
    writeFileSync(
      join(directory, 'scripts/ci/verify-pwa-release.sh'),
      `#!/bin/sh\n[ -s "$1/release-manifest.json" ] && [ -s "$1/release-manifest.sig" ] && exit ${spec.live.verifies === false ? 1 : 0}\nexit 1\n`,
      { mode: 0o755 },
    );
    const answers = {
      'release-manifest.json': spec.live.manifest,
      'release-manifest.sig': spec.live.signature ?? { status: 200 },
    };
    for (const [name, answer] of Object.entries(answers)) {
      if (answer === undefined || answer === 'unreachable') continue;
      const body =
        name === 'release-manifest.json'
          ? JSON.stringify({ commit: (answer as { commit?: string }).commit ?? C, sequence: 3 })
          : 'signature-bytes';
      writeFileSync(join(directory, `live-${name}`), body);
      writeFileSync(join(directory, `live-${name}.status`), String((answer as { status: number }).status));
    }
    for (const [pair, status] of Object.entries(spec.compare ?? {})) {
      writeFileSync(join(directory, `compare-${pair}.json`), JSON.stringify({ status }));
    }
    writeFileSync(
      join(bin, 'curl'),
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'out=""; url=""',
        'while (($#)); do case "$1" in --output) shift; out="$1" ;; --write-out|--max-time|--retry|--header) shift ;; --*) ;; *) url="$1" ;; esac; shift; done',
        `dir=${JSON.stringify(directory)}`,
        'name="${url##*/}"; name="${name%%\\?*}"',
        '[[ -f ${dir}/live-${name}.status ]] || exit 6',
        'cp "${dir}/live-${name}" "${out}"',
        'cat "${dir}/live-${name}.status"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, 'gh'),
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'url=""; filter=""',
        'while (($#)); do case "$1" in api|--paginate) ;; --jq) shift; filter="$1" ;; *) [[ -z $url ]] && url="$1" ;; esac; shift; done',
        `dir=${JSON.stringify(directory)}`,
        'case "$url" in',
        '  */compare/*) file="${dir}/compare-${url#*/compare/}.json" ;;',
        '  *) echo "the gate must not read anything but compare, got: ${url}" >&2; exit 2 ;;',
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
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        GITHUB_OUTPUT: output,
        GH_TOKEN: 'unused',
        DELETED: spec.deleted === true ? 'true' : 'false',
        AFTER: spec.after,
        REPOSITORY: 'example/repo',
        RUN_ID: '99',
      },
    });
    return { status: result.exitCode, err: result.stderr.toString(), deploy: readFileSync(output, 'utf8').trim() };
  }

  const liveC: Live = { manifest: { status: 200, commit: C } };

  test("what is live is the live record's commit: B (older than the live C) deploys nothing, whatever the run history says", () => {
    // This one fixture stands for each history the old run-based lookup got wrong: C deployed by the legacy per-merge
    // trigger on another branch, C's run cancelled while finishing, and C's run later re-run and failed. The gate reads
    // no run history at all (its fake gh refuses everything but compare), so none of them can hide C.
    const result = runGate({ live: liveC, compare: { [`${C}...${B}`]: 'behind' }, after: B });
    expect(result).toMatchObject({ status: 0, deploy: 'deploy=false' });
    expect(result.err).toBe('');
  });

  test('a descendant of the live commit deploys, and so does the live commit itself (the kit still needs its green run)', () => {
    expect(runGate({ live: liveC, compare: { [`${C}...${A}`]: 'ahead' }, after: A })).toMatchObject({
      status: 0,
      deploy: 'deploy=true',
    });
    expect(runGate({ live: liveC, compare: { [`${C}...${C}`]: 'identical' }, after: C })).toMatchObject({
      status: 0,
      deploy: 'deploy=true',
    });
  });

  test('a diverged commit deploys nothing', () => {
    expect(runGate({ live: liveC, compare: { [`${C}...${B}`]: 'diverged' }, after: B }).deploy).toBe('deploy=false');
  });

  test('a 404 for the manifest passes the PRE-FILTER only (the deploy job reads the Pages API and is the authority)', () => {
    expect(runGate({ live: { manifest: { status: 404 } }, after: A })).toMatchObject({
      status: 0,
      deploy: 'deploy=true',
    });
  });

  test('the live record is read as unproven unless it is reachable, a 200, signed and names a commit: every other state fails the job', () => {
    const cases: Array<[string, Live]> = [
      ['manifest unreachable', { manifest: 'unreachable' }],
      ['manifest HTTP 500', { manifest: { status: 500 } }],
      ['manifest redirected', { manifest: { status: 301 } }],
      ['signature unreachable', { manifest: { status: 200, commit: C }, signature: 'unreachable' }],
      ['signature missing (404)', { manifest: { status: 200, commit: C }, signature: { status: 404 } }],
      ['record does not verify', { manifest: { status: 200, commit: C }, verifies: false }],
      ['commit is not a full id', { manifest: { status: 200, commit: 'abc123' } }],
    ];
    for (const [label, live] of cases) {
      const result = runGate({ live, compare: { [`${C}...${B}`]: 'ahead' }, after: B });
      expect({ label, status: result.status, deploy: result.deploy }).toEqual({ label, status: 1, deploy: '' });
    }
  });

  test('a compare it cannot read, or a status it does not know, fails the job instead of guessing', () => {
    const unreadable = runGate({ live: liveC, after: B });
    expect(unreadable.status).not.toBe(0);
    expect(unreadable.deploy).toBe('');
    const unknown = runGate({ live: liveC, compare: { [`${C}...${B}`]: 'mystery' }, after: B });
    expect(unknown.status).toBe(1);
    expect(unknown.err).toContain('unexpected compare status');
    expect(unknown.deploy).toBe('');
  });

  test('a deleted ref deploys nothing', () => {
    expect(runGate({ live: liveC, after: A, deleted: true })).toMatchObject({ status: 0, deploy: 'deploy=false' });
  });

  test("the live record is proved with the deploy job's own script before its commit is read, and event.before is not read", () => {
    expect(section.indexOf('./scripts/ci/verify-pwa-release.sh')).toBeGreaterThan(0);
    expect(section.indexOf('./scripts/ci/verify-pwa-release.sh')).toBeLessThan(section.indexOf("jq -er '.commit'"));
    expect(section).toContain('./scripts/ci/hosted-app-origin.sh');
    expect(text).not.toContain('github.event.before }}');
    expect(script).not.toContain('BEFORE');
    expect(script).not.toContain('actions/runs');
  });

  test('there is no manual trigger, and the gate needs no more than contents: read', () => {
    expect(text).not.toMatch(/^  workflow_dispatch:/mu);
    expect(text).not.toContain('actions: read');
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

describe('the deploy job re-checks, before the upload and on every attempt, against the Pages API and the signed record', () => {
  const text = readFileSync(join(repository, '.github/workflows/pwa-pages-v5.yaml'), 'utf8');
  const stepSource = (name: string, until: string) => {
    const start = text.indexOf(`      - name: ${name}`);
    const body = text.slice(start, text.indexOf(until, start + 1));
    return {
      body,
      script: (body.split('        run: |\n')[1] ?? '')
        .split('\n')
        .map(line => (line.startsWith('          ') ? line.slice(10) : line))
        .join('\n'),
    };
  };
  const read = stepSource('Read the production deployment', '      # The artifact is readable');
  const decide = stepSource('Refuse a release that goes backwards', '      # The bytes `deploy` uploads');
  const TOKEN = 'token-not-in-args';
  const ID = 'abcd1234-0000-4000-8000-000000000000';
  const ALIAS_HOST = 'ferretry-v5.pages.dev';
  const DEPLOYMENT_HOST = `abcd1234.${ALIAS_HOST}`;

  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.invalid',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.invalid',
      },
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };

  /** c1 -> c2 -> c3 on main, and d off c1 (diverged from both). */
  function repo() {
    const directory = mkdtempSync(join(tmpdir(), 'preview-live-'));
    scratch.push(directory);
    git(directory, 'init', '-q', '-b', 'main');
    const make = (message: string) => {
      git(directory, 'commit', '-q', '--allow-empty', '-m', message);
      return git(directory, 'rev-parse', 'HEAD');
    };
    const c1 = make('c1');
    const c2 = make('c2');
    const c3 = make('c3');
    git(directory, 'checkout', '-q', '-b', 'side', c1);
    const d = make('d');
    return { directory, c1, c2, c3, d };
  }

  type Answer = { status: number; body?: unknown } | 'unreachable';
  type Spec = {
    /** The Pages API's answer for the project. */
    api: Answer;
    /** The signed record at the production deployment's own URL, and at the alias (default: the same). */
    deployment?: Answer;
    alias?: Answer;
    signature?: { deployment?: Answer; alias?: Answer };
    verifies?: boolean;
    after: string;
    sequence?: number;
  };

  /** Runs step 1 (with the token) and, if it passes, step 2 (without any), as GitHub would, with fake curl. */
  function run(directory: string, spec: Spec) {
    for (const dir of ['scripts/ci', '.bin', '.runner']) mkdirSync(join(directory, dir), { recursive: true });
    writeFileSync(
      join(directory, 'scripts/ci/hosted-app-origin.sh'),
      `#!/bin/sh\nenv > .seen-by-origin\necho https://${ALIAS_HOST}\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(directory, 'scripts/ci/verify-pwa-release.sh'),
      `#!/bin/sh\nenv > .seen-by-verify\n[ -s "$1/release-manifest.json" ] && [ -s "$1/release-manifest.sig" ] && exit ${spec.verifies === false ? 1 : 0}\nexit 1\n`,
      { mode: 0o755 },
    );
    const put = (host: string, name: string, answer: Answer | undefined) => {
      if (answer === undefined || answer === 'unreachable') return;
      mkdirSync(join(directory, '.fake', host), { recursive: true });
      const body = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? {});
      writeFileSync(join(directory, '.fake', host, name), body);
      writeFileSync(join(directory, '.fake', host, `${name}.status`), String(answer.status));
    };
    const ok: Answer = { status: 200, body: 'signature-bytes' };
    put('api', 'project', spec.api);
    put(DEPLOYMENT_HOST, 'release-manifest.json', spec.deployment);
    put(DEPLOYMENT_HOST, 'release-manifest.sig', spec.signature?.deployment ?? ok);
    put(ALIAS_HOST, 'release-manifest.json', spec.alias ?? spec.deployment);
    put(ALIAS_HOST, 'release-manifest.sig', spec.signature?.alias ?? ok);
    writeFileSync(
      join(directory, '.bin/curl'),
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'printf "%s\\n" "$*" >> .curl-args',
        'out=""; url=""',
        'while (($#)); do case "$1" in --output) shift; out="$1" ;; --header) shift; [[ $1 == @- ]] && cat >/dev/null ;; --write-out|--max-time|--retry) shift ;; --*) ;; *) url="$1" ;; esac; shift; done',
        'case "$url" in',
        '  https://api.cloudflare.com/client/v4/accounts/acct/pages/projects/ferretry-v5) host=api; name=project ;;',
        '  https://*) rest="${url#https://}"; host="${rest%%/*}"; name="${rest#*/}"; name="${name%%\\?*}" ;;',
        '  *) echo "unexpected url: ${url}" >&2; exit 2 ;;',
        'esac',
        '[[ -f ".fake/${host}/${name}.status" ]] || exit 6',
        'cp ".fake/${host}/${name}" "${out}"',
        'cat ".fake/${host}/${name}.status"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const output = join(directory, 'github-output');
    writeFileSync(output, '');
    const base: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${join(directory, '.bin')}:${process.env.PATH ?? ''}`,
      GITHUB_OUTPUT: output,
      GITHUB_RUN_ID: '99',
      RUNNER_TEMP: join(directory, '.runner'),
    };
    delete base.CLOUDFLARE_API_TOKEN;
    delete base.CLOUDFLARE_ACCOUNT_ID;
    const first = Bun.spawnSync(['bash', '-c', read.script], {
      cwd: directory,
      env: { ...base, CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: 'acct' },
    });
    if (first.exitCode !== 0) {
      return { step: 1, status: first.exitCode, err: first.stderr.toString(), out: '' };
    }
    const second = Bun.spawnSync(['bash', '-c', decide.script], {
      cwd: directory,
      env: { ...base, AFTER: spec.after, SEQUENCE: String(spec.sequence ?? 10), ATTEMPT: '1' },
    });
    return {
      step: 2,
      status: second.exitCode,
      err: second.stderr.toString(),
      out: readFileSync(output, 'utf8').trim(),
    };
  }

  const project = (deployment: unknown) => ({
    status: 200,
    body: { success: true, result: { name: 'ferretry-v5', canonical_deployment: deployment } },
  });
  const deployedAt = (commit: string | undefined, over: Record<string, unknown> = {}) => ({
    id: ID,
    url: `https://${DEPLOYMENT_HOST}`,
    project_name: 'ferretry-v5',
    deployment_trigger: { metadata: commit === undefined ? {} : { commit_hash: commit } },
    ...over,
  });
  const record = (commit: string, sequence = 5) => ({ status: 200, body: { commit, sequence } });
  const live = (commit: string, sequence = 5) => ({
    api: project(deployedAt(commit)),
    deployment: record(commit, sequence),
  });

  test('a stale gate "allow" cannot deploy once the live release has moved on: an older commit is refused', () => {
    const r = repo();
    const result = run(r.directory, { ...live(r.c3), after: r.c2 });
    expect(result).toMatchObject({ step: 2, status: 1, out: '' });
    expect(result.err).toContain('is not an ancestor');
  });

  test('a diverged commit is refused', () => {
    const r = repo();
    const result = run(r.directory, { ...live(r.c3), after: r.d });
    expect(result.status).toBe(1);
    expect(result.err).toContain('is not an ancestor');
  });

  test('a descendant of the live commit with a higher sequence deploys; one that does not exceed the live sequence is refused', () => {
    const r = repo();
    expect(run(r.directory, { ...live(r.c2, 5), after: r.c3, sequence: 6 })).toMatchObject({
      status: 0,
      out: 'skip=false',
    });
    for (const sequence of [5, 4]) {
      const result = run(r.directory, { ...live(r.c2, 5), after: r.c3, sequence });
      expect(result.status).toBe(1);
      expect(result.err).toContain('does not exceed the live signed sequence');
    }
  });

  test('an identical commit is a no-op: nothing is uploaded and the job stays green', () => {
    const r = repo();
    expect(run(r.directory, { ...live(r.c3, 5), after: r.c3, sequence: 6 })).toMatchObject({
      status: 0,
      out: 'skip=true',
    });
  });

  test('the first deploy ever (the API shows no production deployment) deploys, and needs no record', () => {
    const r = repo();
    expect(run(r.directory, { api: project(null), after: r.c1 })).toMatchObject({ status: 0, out: 'skip=false' });
  });

  test('step 1 fails on an API error, an unreadable or unparseable answer, or a project without the production field', () => {
    const r = repo();
    const cases: Array<[string, Answer]> = [
      ['unreachable', 'unreachable'],
      ['HTTP 500', { status: 500, body: {} }],
      ['HTTP 403', { status: 403, body: { success: false } }],
      ['not json', { status: 200, body: 'not json' }],
      ['success false', { status: 200, body: { success: false, result: { canonical_deployment: null } } }],
      ['no production field', { status: 200, body: { success: true, result: { name: 'ferretry-v5' } } }],
    ];
    for (const [label, api] of cases) {
      const result = run(r.directory, { api, deployment: record(r.c3), after: r.c3 });
      expect({ label, step: result.step, status: result.status }).toEqual({ label, step: 1, status: 1 });
    }
  });

  test('a deployment that is not bound to this project and this address is refused: another project, a bad id, a foreign or alias URL', () => {
    const r = repo();
    const cases: Array<[string, unknown]> = [
      [
        'wrong project name on the result',
        { ...project(deployedAt(r.c3)).body, result: { name: 'other', canonical_deployment: deployedAt(r.c3) } },
      ],
      ['wrong deployment project_name', project(deployedAt(r.c3, { project_name: 'other' })).body],
      ['id is not a deployment id', project(deployedAt(r.c3, { id: 'abcd1234' })).body],
      ['url of another deployment', project(deployedAt(r.c3, { url: `https://ffffffff.${ALIAS_HOST}` })).body],
      ['url is the mutable alias', project(deployedAt(r.c3, { url: `https://${ALIAS_HOST}` })).body],
      ['url on another host', project(deployedAt(r.c3, { url: `https://abcd1234.evil.example` })).body],
    ];
    for (const [label, body] of cases) {
      const result = run(r.directory, { api: { status: 200, body }, deployment: record(r.c3), after: r.c3 });
      expect({ label, step: result.step, status: result.status, out: result.out }).toEqual({
        label,
        step: 2,
        status: 1,
        out: '',
      });
    }
  });

  test("the deployment's own signed record must be there and verify; a missing one is never a first deploy", () => {
    const r = repo();
    const cases: Array<[string, Partial<Spec>]> = [
      ['record 404', { deployment: { status: 404 } }],
      ['record unreachable', { deployment: 'unreachable' }],
      ['signature 404', { deployment: record(r.c3), signature: { deployment: { status: 404 } } }],
      ['does not verify', { deployment: record(r.c3), verifies: false }],
      ['commit is not an id', { deployment: record('abc') }],
      ['sequence is not a number', { deployment: { status: 200, body: { commit: r.c3, sequence: 'x' } } }],
    ];
    for (const [label, partial] of cases) {
      const result = run(r.directory, { api: project(deployedAt(r.c3)), after: r.c3, ...partial });
      expect({ label, status: result.status, out: result.out }).toEqual({ label, status: 1, out: '' });
    }
  });

  test('the deployment record must agree with the API commit, and the ALIAS record with the deployment record (a stale alias cannot authorise a rewind or a false skip)', () => {
    const r = repo();
    // The API says c3; the deployment's own record says c2.
    expect(run(r.directory, { api: project(deployedAt(r.c3)), deployment: record(r.c2), after: r.c3 }).status).toBe(1);
    // Everything about the deployment says c3, but the alias still serves c2: not a record we can reason from.
    const staleAlias = run(r.directory, { ...live(r.c3), alias: record(r.c2), after: r.c3 });
    expect(staleAlias.status).toBe(1);
    expect(staleAlias.err).toContain('differs from the production deployment');
    // A different sequence on the alias is a difference too; a missing alias record fails.
    expect(run(r.directory, { ...live(r.c3, 5), alias: record(r.c3, 4), after: r.c3 }).status).toBe(1);
    expect(run(r.directory, { ...live(r.c3), alias: { status: 404 }, after: r.c3 }).status).toBe(1);
  });

  test("with no recorded commit hash the deployment's OWN record decides (not the alias, which must then agree)", () => {
    const r = repo();
    const noHash = project(deployedAt(undefined));
    expect(run(r.directory, { api: noHash, deployment: record(r.c2, 5), after: r.c3, sequence: 6 })).toMatchObject({
      status: 0,
      out: 'skip=false',
    });
    // An older record at the deployment's own URL refuses a rewind even though the alias would have allowed it.
    expect(run(r.directory, { api: noHash, deployment: record(r.c3, 5), after: r.c2, sequence: 6 }).status).toBe(1);
    // An alias that is newer or older than the deployment's own record fails closed.
    expect(
      run(r.directory, { api: noHash, deployment: record(r.c3), alias: record(r.c1), after: r.c3, sequence: 6 }).status,
    ).toBe(1);
  });

  test("a recorded commit hash that is PRESENT but malformed fails; only an ABSENT hash falls back to the deployment's own record", () => {
    const r = repo();
    for (const hash of ['abc123', '', 'Z'.repeat(40), r.c2.toUpperCase(), `${r.c2}0`, 7, true, ['x']]) {
      const result = run(r.directory, {
        api: project(deployedAt(undefined, { deployment_trigger: { metadata: { commit_hash: hash } } })),
        deployment: record(r.c2, 5),
        after: r.c3,
        sequence: 6,
      });
      expect({ hash, step: result.step, status: result.status, out: result.out }).toEqual({
        hash,
        step: 2,
        status: 1,
        out: '',
      });
    }
    // Absent and null both fall back (the record decides).
    for (const metadata of [{}, { commit_hash: null }]) {
      const absent = run(r.directory, {
        api: project(deployedAt(undefined, { deployment_trigger: { metadata } })),
        deployment: record(r.c2, 5),
        after: r.c3,
        sequence: 6,
      });
      expect(absent).toMatchObject({ status: 0, out: 'skip=false' });
    }
  });

  test('a live commit that is not in the checkout is refused, not assumed old', () => {
    const r = repo();
    const unknown = 'f'.repeat(40);
    const result = run(r.directory, { ...live(unknown), after: r.c3 });
    expect(result.status).toBe(1);
    expect(result.err).toContain('is not in this checkout');
  });

  test('the token reaches only step 1, never an argument, and never a script run from the checkout', () => {
    const r = repo();
    expect(run(r.directory, { ...live(r.c2, 5), after: r.c3, sequence: 6 }).status).toBe(0);
    for (const seen of ['.seen-by-origin', '.seen-by-verify']) {
      const env = readFileSync(join(r.directory, seen), 'utf8');
      expect(env).not.toContain(TOKEN);
      expect(env).not.toContain('CLOUDFLARE_');
    }
    expect(readFileSync(join(r.directory, '.curl-args'), 'utf8')).not.toContain(TOKEN);
    // Step 1 runs no script from the checkout; step 2 holds no secret at all.
    expect(read.script).not.toContain('./scripts/');
    expect(read.body).toContain('secrets.CLOUDFLARE_PAGES_V5_API_TOKEN');
    expect(decide.body).not.toContain('secrets.');
    expect(decide.script).not.toContain('CLOUDFLARE');
  });

  test('the steps sit before the upload, the upload is skipped on a no-op, and it records the commit', () => {
    const at = (needle: string) => text.indexOf(needle);
    // Across the jobs: project reads, verify decides, deploy refuses a stale head and then uploads.
    expect(at('- name: Refuse a release that goes backwards')).toBeGreaterThan(
      at('- name: Read the production deployment'),
    );
    expect(at('name: Refuse a stale commit')).toBeGreaterThan(at('- name: Refuse a release that goes backwards'));
    expect(at('name: Deploy production bundle')).toBeGreaterThan(at('name: Refuse a stale commit'));
    // A no-op decision ("already live") skips the hand-off upload and, in deploy, the download, the install and the upload.
    expect(text).toContain("if: steps.live.outputs.skip != 'true'");
    expect(text.match(/if: needs\.verify\.outputs\.skip != 'true'/gu)).toHaveLength(3);
    expect(text).toContain('--commit-hash="${GITHUB_SHA}"');
    expect(read.script).toContain('--header @-');
  });

  test('mutation: a deploy job without the live check, or with the token in the checking step, is refused', () => {
    const withoutRead = gate(
      checkout(p =>
        edit(
          p('.github/workflows/pwa-pages-v5.yaml'),
          /      - name: Read the production deployment[\s\S]*?(?=      # The artifact is readable)/u,
          '',
        ),
      ),
    );
    expect(withoutRead.status).toBe(1);
    expect(withoutRead.err).toContain('Pages API');
    const tokenInStep2 = gate(
      checkout(p =>
        edit(
          p('.github/workflows/pwa-pages-v5.yaml'),
          '          AFTER: ${{ github.sha }}\n          SEQUENCE:',
          '          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_PAGES_V5_API_TOKEN }}\n          AFTER: ${{ github.sha }}\n          SEQUENCE:',
        ),
      ),
    );
    expect(tokenInStep2.status).toBe(1);
    expect(tokenInStep2.err).toContain('no secret');
  });
});

describe('the Cloudflare token never meets checkout code (both PWA deploy workflows)', () => {
  const workflows = [
    { file: '.github/workflows/pwa-pages.yaml', tokenJob: 'deploy', secret: 'secrets.CLOUDFLARE_API_TOKEN' },
    {
      file: '.github/workflows/pwa-pages-v5.yaml',
      tokenJob: 'deploy',
      secret: 'secrets.CLOUDFLARE_PAGES_V5_API_TOKEN',
    },
  ];
  const message = 'the token must never meet checkout code';

  test('this checkout passes, and the token-holding jobs are the two that were meant to hold it', () => {
    expect(gate(checkout())).toMatchObject({ status: 0 });
    for (const { file, secret } of workflows) {
      const text = readFileSync(join(repository, file), 'utf8');
      // Every step that names the token sits in a job without checkout, nix, bun or bunx.
      const jobs = text.split(/^ {2}(?=[a-z][a-z-]*:\n)/mu).filter(job => job.includes(secret));
      expect(jobs.length).toBeGreaterThan(0);
      for (const job of jobs) {
        const code = job.replace(/^\s*#.*$/gmu, '');
        expect(code).not.toMatch(/actions\/checkout|uses: \.\/|nix develop|\bbunx?\b|\bnpx\b/u);
      }
    }
  });

  for (const { file, tokenJob } of workflows) {
    const tokenJobStart = (text: string) => text.indexOf(`\n  ${tokenJob}:\n`) + 1;
    const addStepToTokenJob = (step: string) => (text: string) => {
      const at = tokenJobStart(text);
      const steps = text.indexOf('    steps:\n', at) + '    steps:\n'.length;
      return `${text.slice(0, steps)}${step}${text.slice(steps)}`;
    };
    const refused = (mutate: (text: string) => string, expected: string) => {
      const result = gate(
        checkout(p => {
          writeFileSync(p(file), mutate(readFileSync(p(file), 'utf8')));
        }),
      );
      expect(result.status).toBe(1);
      expect(result.err).toContain(expected);
    };

    test(`${file}: an actions/checkout step in the token job is refused`, () => {
      refused(
        addStepToTokenJob(
          '      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0\n        with:\n          persist-credentials: false\n',
        ),
        message,
      );
    });

    test(`${file}: a local action (the nix installer) in the token job is refused`, () => {
      refused(addStepToTokenJob('      - uses: ./.github/actions/install-nix\n'), message);
    });

    test(`${file}: nix develop, bunx or npx in a token job's run step is refused`, () => {
      for (const command of ['nix develop .#ci -c true', 'bunx wrangler --version', 'npx --yes wrangler --version']) {
        refused(addStepToTokenJob(`      - name: sneaky\n        run: ${command}\n`), message);
      }
    });

    test(`${file}: a secret in the job-level env (so the install step holds it) is refused`, () => {
      refused(text => {
        const at = tokenJobStart(text);
        const runsOn = text.indexOf('    runs-on:', at);
        return `${text.slice(0, runsOn)}    env:\n      LEAK: \${{ secrets.CLOUDFLARE_API_TOKEN }}\n${text.slice(runsOn)}`;
      }, 'job-level env');
    });

    test(`${file}: a wrangler that is not installed at the pinned version first is refused`, () => {
      refused(
        text => text.replace(/--save-exact "wrangler@\$\{WRANGLER_VERSION\}"/gu, '--save-exact wrangler@latest'),
        'WRANGLER_VERSION',
      );
      refused(text => text.replace(/ --ignore-scripts/gu, ''), 'without first installing');
    });

    test(`${file}: a wrangler version that is not exact is refused`, () => {
      for (const version of ['^4.93.0', 'latest', '4', '4.93']) {
        refused(text => text.replace(/WRANGLER_VERSION: [^\n]+/u, `WRANGLER_VERSION: ${version}`), 'exact x.y.z');
      }
    });
  }

  test('the two workflows must pin the same wrangler', () => {
    const result = gate(
      checkout(p =>
        edit(p('.github/workflows/pwa-pages.yaml'), /WRANGLER_VERSION: [^\n]+/u, 'WRANGLER_VERSION: 4.92.0'),
      ),
    );
    expect(result.status).toBe(1);
    expect(result.err).toContain('pin different wrangler versions');
  });

  test('a token secret read in no job at all fails the check instead of passing it vacuously', () => {
    const result = gate(
      checkout(p => edit(p('.github/workflows/pwa-pages.yaml'), /secrets\.CLOUDFLARE_/gu, 'secrets.RENAMED_')),
    );
    expect(result.status).toBe(1);
    expect(result.err).toContain('no job reads a CLOUDFLARE secret');
  });

  test('the preview deploy job needs verify, and its hand-off artifacts are scoped to the attempt', () => {
    const file = '.github/workflows/pwa-pages-v5.yaml';
    const unscoped = gate(
      checkout(p =>
        edit(p(file), 'name: pwa-release-verified-${{ github.run_attempt }}', 'name: pwa-release-verified'),
      ),
    );
    expect(unscoped.status).toBe(1);
    expect(unscoped.err).toContain('github.run_attempt');
    const unneeded = gate(
      checkout(p =>
        edit(p(file), 'needs: [gate, build, sign, project, verify]', 'needs: [gate, build, sign, project]'),
      ),
    );
    expect(unneeded.status).toBe(1);
    expect(unneeded.err).toContain('deploy must need both');
  });
});

describe('the Pages project answer leaves the token job only as what the decision reads', () => {
  const text = readFileSync(join(repository, '.github/workflows/pwa-pages-v5.yaml'), 'utf8');
  const start = text.indexOf('      - name: Keep only what the decision reads');
  const body = text.slice(start, text.indexOf('      - uses: actions/upload-artifact', start));
  const script = (body.split('        run: |\n')[1] ?? '')
    .split('\n')
    .map(line => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
  const commit = 'a'.repeat(40);

  function filtered(project: unknown) {
    const directory = mkdtempSync(join(tmpdir(), 'pages-decision-'));
    scratch.push(directory);
    writeFileSync(join(directory, 'pages-project.json'), JSON.stringify(project));
    const result = Bun.spawnSync(['bash', '-c', script], { env: { ...process.env, RUNNER_TEMP: directory } });
    expect(result.exitCode).toBe(0);
    return JSON.parse(readFileSync(join(directory, 'pages-decision', 'pages-project.json'), 'utf8')) as unknown;
  }

  test('the deployment configuration (environment variables) never reaches the artifact', () => {
    const kept = filtered({
      success: true,
      result: {
        name: 'ferretry-v5',
        deployment_configs: { production: { env_vars: { LEAK: { value: 'plaintext-value' } } } },
        canonical_deployment: {
          id: 'abcd1234-0000-4000-8000-000000000000',
          url: 'https://abcd1234.ferretry-v5.pages.dev',
          project_name: 'ferretry-v5',
          env_vars: { LEAK: { value: 'plaintext-value' } },
          deployment_trigger: { type: 'ad_hoc', metadata: { commit_hash: commit, commit_message: 'm' } },
        },
      },
    });
    expect(JSON.stringify(kept)).not.toContain('plaintext-value');
    expect(kept).toEqual({
      success: true,
      result: {
        name: 'ferretry-v5',
        canonical_deployment: {
          id: 'abcd1234-0000-4000-8000-000000000000',
          url: 'https://abcd1234.ferretry-v5.pages.dev',
          project_name: 'ferretry-v5',
          deployment_trigger: { metadata: { commit_hash: commit } },
        },
      },
    });
  });

  test('no production deployment stays null, and a deployment with no recorded hash keeps an empty metadata object', () => {
    expect(filtered({ success: true, result: { name: 'ferretry-v5', canonical_deployment: null } })).toEqual({
      success: true,
      result: { name: 'ferretry-v5', canonical_deployment: null },
    });
    const kept = filtered({
      success: true,
      result: { name: 'ferretry-v5', canonical_deployment: { id: 'x', url: 'u', project_name: 'ferretry-v5' } },
    }) as { result: { canonical_deployment: { deployment_trigger: unknown } } };
    expect(kept.result.canonical_deployment.deployment_trigger).toEqual({ metadata: {} });
  });
});
