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
    // The gate refuses a push that is not a fast-forward of what the ref held (a read-only compare), and fails on a read it cannot make.
    expect(workflow).toContain('compare/${BEFORE}...${AFTER}');
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
      // The never-backwards gate before it is the fast-forward compare.
      expect(text).toContain('compare/${BEFORE}...${AFTER}');
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
