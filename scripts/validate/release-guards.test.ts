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

  test('the tag ruleset script, run with --dry-run, calls nothing and names exactly who may create a v* tag', () => {
    const run = (...args: string[]) =>
      Bun.spawnSync([join(repository, 'scripts/local/setup-release-tag-ruleset.sh'), '--dry-run', ...args], {
        env: { PATH: '/usr/bin:/bin' },
      });
    const plain = run();
    expect(plain.exitCode).toBe(0);
    const text = plain.stdout.toString();
    expect(text).toContain("the repository role 'admin'");
    expect(text).toContain('refs/tags/v*');
    expect(text).toContain('"type":"creation"');
    expect(text).toContain('"actor_id":5,"actor_type":"RepositoryRole"');
    const app = run('--app-id', '123');
    expect(app.stdout.toString()).toContain('"actor_id":123,"actor_type":"Integration"');
    expect(run('--app-id', 'x;rm').exitCode).toBe(64);
    expect(run('--role', 'write').exitCode).toBe(64);
  });

  test('MAJOR-4 a CD job that is not behind main-only (even a new publishing job) is refused, and the text says what the ruleset is', () => {
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
    const ok = gate(checkout());
    expect(ok.out).toContain('does not stop an agent pushing as the owner (Admin)');
    const script = readFileSync(join(repository, 'scripts/local/setup-release-tag-ruleset.sh'), 'utf8');
    expect(script).toContain("an agent with the owner's credential can still push one");
    expect(script).toContain('READS IT\n# BACK and prints the bypass actors by name');
  });

  test('n2 the ruleset script dies with a message when --repo has no value', () => {
    const result = Bun.spawnSync(
      [join(repository, 'scripts/local/setup-release-tag-ruleset.sh'), '--dry-run', '--repo'],
      {
        env: { PATH: '/usr/bin:/bin' },
      },
    );
    expect(result.exitCode).toBe(64);
    expect(result.stderr.toString()).toContain('--repo needs a value');
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

  test('the preview triggered by main is refused', () => {
    const result = gate(
      checkout(p => edit(p('.github/workflows/pwa-pages-v5.yaml'), 'branches: [rebuild/5.0]', 'branches: [main]')),
    );
    expect(result.status).toBe(1);
    expect(result.err).toContain('triggered by pushes to rebuild/5.0 alone');
  });

  test('a preview job that stops repeating the ref is refused', () => {
    const result = gate(
      checkout(p =>
        edit(
          p('.github/workflows/pwa-pages-v5.yaml'),
          /    needs: build\n    if: github.ref == 'refs\/heads\/rebuild\/5.0'\n/,
          '    needs: build\n',
        ),
      ),
    );
    expect(result.status).toBe(1);
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
  const honest =
    'it cannot publish from a 5.0 commit made after this guard lands. Any commit made before it (all current 5.0 history) can still publish if tagged.';

  test('the gate says an older 5.0 commit can still publish if tagged', () => {
    const { out } = gate(checkout());
    expect(out).toContain('can still publish if tagged');
  });

  test('the ruleset script says the whole honest sentence in its header and its warning', () => {
    const text = readFileSync(join(repository, 'scripts/local/setup-release-tag-ruleset.sh'), 'utf8');
    const flat = text.replace(/\n# /gu, ' ');
    expect(flat.split(honest).length - 1).toBeGreaterThanOrEqual(2);
  });

  test('no script claims a 5.0 commit cannot publish without the made-after qualifier', () => {
    for (const file of ['scripts/local/setup-release-tag-ruleset.sh', 'scripts/validate/release-guards.sh']) {
      const text = readFileSync(join(repository, file), 'utf8').replace(/\n#\s*/gu, ' ');
      for (const match of text.matchAll(/cannot publish from a 5\.0 commit(?! made after this guard lands)/gu))
        throw new Error(`${file}: unqualified claim at ${match.index}`);
    }
  });
});
