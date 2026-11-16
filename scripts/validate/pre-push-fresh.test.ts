import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GATE = join(import.meta.dir, 'pre-push-fresh.sh');
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface Sandbox {
  readonly work: string;
  readonly git: (...args: string[]) => string;
  /** Another clone's push of one new commit to main, so `origin/main` moves past the feature branch. */
  readonly advanceBase: () => void;
  /** The gate, run as pre-commit runs it for a push of `local` to `remote` (default: the feature branch). */
  readonly push: (options?: {
    readonly local?: string;
    readonly remote?: string;
    readonly sha?: string;
    readonly env?: Record<string, string>;
  }) => { readonly code: number | null; readonly out: string };
}

/** A bare origin holding `main`, a clone with a `feature` branch cut from it, and a second clone to move main. */
function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'fy-pre-push-fresh-'));
  temporary.push(root);
  const home = join(root, 'home');
  mkdirSync(home);
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = t\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n',
  );
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  const run = (cwd: string, ...args: string[]): string => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  const other = join(root, 'other');
  run(root, 'init', '--bare', '-q', origin);
  run(root, 'clone', '-q', origin, work);
  writeFileSync(join(work, 'a.txt'), 'a\n');
  run(work, 'add', '.');
  run(work, 'commit', '-q', '-m', 'init');
  run(work, 'push', '-q', 'origin', 'main');
  run(work, 'remote', 'set-head', 'origin', 'main');
  run(work, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(work, 'f.txt'), 'f\n');
  run(work, 'add', '.');
  run(work, 'commit', '-q', '-m', 'feature work');
  run(root, 'clone', '-q', origin, other);
  let moves = 0;
  return {
    work,
    git: (...args) => run(work, ...args),
    advanceBase: () => {
      moves += 1;
      writeFileSync(join(other, `base-${moves}.txt`), 'b\n');
      run(other, 'add', '.');
      run(other, 'commit', '-q', '-m', `base ${moves}`);
      run(other, 'push', '-q', 'origin', 'main');
    },
    push: (options = {}) => {
      const result = spawnSync('bash', [GATE], {
        cwd: work,
        encoding: 'utf8',
        env: {
          ...env,
          PRE_COMMIT_LOCAL_BRANCH: options.local ?? 'refs/heads/feature',
          PRE_COMMIT_REMOTE_BRANCH: options.remote ?? 'refs/heads/feature',
          PRE_COMMIT_TO_REF: options.sha ?? run(work, 'rev-parse', 'HEAD'),
          ...options.env,
        },
      });
      return { code: result.status, out: `${result.stdout}${result.stderr}` };
    },
  };
}

test('a branch behind its base is refused, with the fixed sentence', () => {
  const box = sandbox();
  box.advanceBase();
  const { code, out } = box.push();
  expect(code).toBe(1);
  expect(out).toContain(
    'feature is behind main: rebase onto origin/main first (or merge it on a shared branch). Set FY_ALLOW_BEHIND_PUSH=1 to push anyway.',
  );
});

test('a branch with nothing new on its base is allowed', () => {
  const box = sandbox();
  expect(box.push().code).toBe(0);
});

test('a branch rebased onto the moved base is allowed', () => {
  const box = sandbox();
  box.advanceBase();
  box.git('fetch', '-q', 'origin');
  box.git('rebase', '-q', 'origin/main');
  expect(box.push().code).toBe(0);
});

test('a branch that merged the moved base is allowed', () => {
  const box = sandbox();
  box.advanceBase();
  box.git('fetch', '-q', 'origin');
  box.git('merge', '-q', '--no-edit', 'origin/main');
  expect(box.push().code).toBe(0);
});

test('FY_ALLOW_BEHIND_PUSH=1 lets a behind branch through', () => {
  const box = sandbox();
  box.advanceBase();
  expect(box.push({ env: { FY_ALLOW_BEHIND_PUSH: '1' } }).code).toBe(0);
});

test('a tag push is allowed even when the tagged commit is behind', () => {
  const box = sandbox();
  box.advanceBase();
  box.git('tag', 'v1.0.0');
  expect(box.push({ local: 'refs/tags/v1.0.0', remote: 'refs/tags/v1.0.0' }).code).toBe(0);
});

test('a branch delete (no local ref or sha) is allowed', () => {
  const box = sandbox();
  box.advanceBase();
  expect(box.push({ local: '', remote: 'refs/heads/feature', sha: '' }).code).toBe(0);
});

test('a run outside a push (no pre-commit refs) is allowed', () => {
  const box = sandbox();
  box.advanceBase();
  expect(box.push({ local: '', remote: '', sha: '' }).code).toBe(0);
});

test('pushing the base branch itself is not gated', () => {
  const box = sandbox();
  box.advanceBase();
  box.git('checkout', '-q', 'main');
  expect(box.push({ local: 'refs/heads/main', remote: 'refs/heads/main' }).code).toBe(0);
});

test('an unreachable origin allows the push with a warning', () => {
  const box = sandbox();
  box.advanceBase();
  box.git('remote', 'set-url', 'origin', '/nonexistent/origin.git');
  const { code, out } = box.push();
  expect(code).toBe(0);
  expect(out).toContain('could not fetch origin/main');
});

test('branch.<name>.ferretry-base names the base, and a branch behind THAT base is refused', () => {
  const box = sandbox();
  box.git('push', '-q', 'origin', 'feature:release');
  box.git('config', 'branch.feature.ferretry-base', 'release');
  // main moves, but the recorded base is `release`, which feature contains.
  box.advanceBase();
  expect(box.push().code).toBe(0);
  // Now release moves past feature.
  box.git('checkout', '-q', '-b', 'moved', 'origin/release');
  writeFileSync(join(box.work, 'r.txt'), 'r\n');
  box.git('add', '.');
  box.git('commit', '-q', '-m', 'release moves');
  box.git('push', '-q', 'origin', 'moved:release');
  box.git('checkout', '-q', 'feature');
  const { code, out } = box.push();
  expect(code).toBe(1);
  expect(out).toContain('feature is behind release: rebase onto origin/release first');
});

test('a branch cut from another branch uses that upstream as its base, not the default branch', () => {
  const box = sandbox();
  box.git('push', '-q', 'origin', 'feature:integration');
  box.git('fetch', '-q', 'origin');
  box.git('checkout', '-q', '-b', 'topic', 'origin/integration');
  // main moves; topic is cut from integration, which it contains.
  box.advanceBase();
  expect(box.push({ local: 'refs/heads/topic', remote: 'refs/heads/topic' }).code).toBe(0);
});

test('a branch that tracks its own name falls back to the default branch', () => {
  const box = sandbox();
  box.git('push', '-q', '-u', 'origin', 'feature');
  box.advanceBase();
  expect(box.push().code).toBe(1);
});

test('--help states the escape variable', () => {
  const result = spawnSync('bash', [GATE, '--help'], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('FY_ALLOW_BEHIND_PUSH=1');
});
