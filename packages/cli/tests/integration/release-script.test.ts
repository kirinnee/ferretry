/**
 * `scripts/ci/release.sh` makes the `release: x.y.z` commit with NO git hook running.
 *
 * WHY THIS MATTERS. `scripts/ci/setup.sh` installs the repo's hooks and points `core.hooksPath` at
 * them, so deleting `.git/hooks/*` was not enough: the whole pre-commit gate set ran on a commit that
 * only touches generated release assets, 100 s of every release (2026-11-16). The fix is command-scope
 * config (`GIT_CONFIG_COUNT`), which outranks any repo or worktree `core.hooksPath`. Each case below
 * runs the REAL script in a scratch repository whose configured hooks path holds a hook that fails the
 * commit and leaves a marker, with a fake semantic-release that only commits.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '../../../..');

let repo = '';
let hooks = '';
let marker = '';
let probe = '';

const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: cleanEnv() });

// A hook run from inside pre-commit would otherwise inherit GIT_DIR and friends and aim at the wrong repository.
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return { ...env, ...extra };
}

const releaseScript = (extra: Record<string, string> = {}) =>
  spawnSync('bash', ['scripts/ci/release.sh'], {
    cwd: repo,
    encoding: 'utf8',
    env: cleanEnv({
      GITHUB_TOKEN: 'not-a-token',
      FY_CI_SETUP_DONE: '1',
      FY_SEMANTIC_RELEASE: join(repo, 'fake-semantic-release.sh'),
      ...extra,
    }),
  });

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'release-script-'));
  hooks = join(repo, 'configured-hooks');
  marker = join(repo, 'hook-ran');
  probe = join(repo, 'inherited-config');
  await mkdir(join(repo, 'scripts/ci'), { recursive: true });
  await mkdir(join(repo, '.github/workflows'), { recursive: true });
  await mkdir(hooks);
  for (const file of ['scripts/ci/release.sh', 'scripts/ci/setup.sh', '.github/workflows/ci.yaml']) {
    await copyFile(join(repositoryRoot, file), join(repo, file));
  }
  for (const name of ['pre-commit', 'commit-msg']) {
    const hook = join(hooks, name);
    await writeFile(hook, `#!/bin/sh\necho ${name} >> '${marker}'\nexit 1\n`);
    await chmod(hook, 0o755);
  }
  // The stand-in for semantic-release: it makes the release commit, as @semantic-release/git does.
  const fake = join(repo, 'fake-semantic-release.sh');
  await writeFile(
    fake,
    `#!/bin/sh\ngit config fy.probe > '${probe}' || true\ngit commit --allow-empty -q -m 'release: 1.2.3'\n`,
  );
  await chmod(fake, 0o755);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.com');
  // The base commit comes first: semantic-release starts from a repository that already has a head.
  git('add', '.');
  git('commit', '-q', '-m', 'chore: base');
  git('config', 'core.hooksPath', hooks);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('scripts/ci/release.sh', () => {
  test('control: the configured hooks do run on a commit made without the script', () => {
    const commit = git('commit', '--allow-empty', '-q', '-m', 'release: 1.2.3');
    expect(commit.status).not.toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  test('the release commit runs no hook from the configured hooks path', () => {
    const result = releaseScript();
    expect(result.stderr + result.stdout).toContain('Release complete');
    expect(result.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(git('log', '-1', '--format=%s').stdout.trim()).toBe('release: 1.2.3');
  });

  test('an inherited GIT_CONFIG_COUNT is extended, not overwritten', () => {
    const result = releaseScript({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'fy.probe',
      GIT_CONFIG_VALUE_0: 'kept',
    });
    expect(result.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(Bun.file(probe).text()).resolves.toBe('kept\n');
  });
});
