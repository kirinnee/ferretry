import { access, constants as fsConstants, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, it } from 'bun:test';
import should from 'should';
import { type E2eEnvironment, withE2eEnvironment } from './fixture';

/**
 * The managed-worktree journeys, driven end to end through both shipped binaries.
 *
 * THIS IS THE TIER THAT WOULD HAVE CAUGHT THE ORIGINAL DEFECT. `fy worktree ls|check|rm` shipped
 * wired to three routes the daemon served none of, and every tier below this one was green over it:
 * the CLI tested against its own fixtures, the daemon tested the routes it had, and nothing was in a
 * position to notice that one program was calling an address the other does not answer at. Here the
 * real `fy` talks to a real `fyd` over a real socket, against a real Git repository on disk — a 404
 * cannot hide.
 *
 * Everything is isolated: a temp state home, an ephemeral loopback port, a throwaway repository, and
 * a managed root the daemon derives from that temp home. No developer checkout is touched and no
 * known port is bound.
 */

const GIT_ENVIRONMENT: Readonly<Record<string, string>> = {
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  LC_ALL: 'C',
};

/** Git for fixture setup only — never the daemon's own runner, so a setup failure is loud. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: cwd, ...GIT_ENVIRONMENT },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`fixture git ${args.join(' ')} failed: ${err.trim()}`);
  return out;
}

/**
 * The compiled daemon beside the compiled CLI this tier already resolved.
 *
 * Derived from `CLI_BIN` rather than recomposed from `uname`, so both binaries always come from one
 * build of one commit — a journey that paired a fresh CLI with a stale daemon would prove nothing.
 */
async function compiledDaemon(environment: E2eEnvironment): Promise<string> {
  const cli = resolve(environment.repositoryRoot, process.env.CLI_BIN ?? '');
  const name = basename(cli);
  if (!name.startsWith('fy-')) throw new Error(`cannot derive the daemon binary from ${cli}`);
  const daemon = join(dirname(cli), `fyd-${name.slice('fy-'.length)}`);
  await access(daemon, fsConstants.X_OK);
  return daemon;
}

/** A repository with one commit, inside the isolated root, to fork worktrees out of. */
async function repository(environment: E2eEnvironment): Promise<string> {
  const root = await environment.assertSafePath(join(environment.paths.home, 'repo'), 'fixture repository');
  await mkdir(join(root, 'packages', 'cli'), { recursive: true });
  await git(root, 'init', '-b', 'main', '--quiet');
  await writeFile(join(root, 'packages', 'cli', 'README.md'), '# fixture\n');
  await git(root, 'add', '--all');
  await git(root, 'commit', '--quiet', '-m', 'chore: seed');
  return root;
}

interface WorktreeRow {
  readonly path: string;
  readonly branch: string;
  readonly relativeCwd: string;
  readonly initialHead: string;
  readonly commonDirectory: string;
  readonly removedAt?: string;
  readonly live?: { readonly head?: string; readonly status?: Record<string, boolean> };
  readonly removal?: { readonly removable: boolean; readonly blockers: readonly { readonly code: string }[] };
}

describe('managed worktree journeys against a real daemon', () => {
  it('should fork, list, check and remove a checkout through the shipped binaries', async () => {
    await withE2eEnvironment(async subject => {
      // Arrange — a real `fyd` on this run's ephemeral port, over this run's temp state home
      const daemon = await compiledDaemon(subject);
      const source = await repository(subject);
      await subject.startDaemon({
        command: [daemon, '--host', '127.0.0.1', '--port', String(subject.ports.api), '--log-level', 'error'],
        readyUrl: subject.httpUrl('/healthz'),
        timeoutMs: 30_000,
      });
      // No FY_TOKEN: the CLI reads the owner-only credential `fyd` minted into this state home.
      const connection = { FY_URL: subject.httpUrl() };

      // Act — the four verbs, in the order a person uses them
      const empty = await subject.runFy(['worktree', 'ls'], connection);
      const forked = await subject.runFy(
        [
          'worktree',
          'fork',
          'feature/e2e',
          '--from',
          join(source, 'packages', 'cli'),
          '--session',
          'e2e-session',
          '--json',
        ],
        connection,
      );
      const created = JSON.parse(forked.out) as { worktree: WorktreeRow; cwd: string };
      const listed = await subject.runFy(['worktree', 'ls', '--json'], connection);
      const rows = (JSON.parse(listed.out) as { worktrees: WorktreeRow[] }).worktrees;
      const checked = await subject.runFy(['worktree', 'check', created.worktree.path, '--json'], connection);
      const removed = await subject.runFy(['worktree', 'rm', created.worktree.path, '--yes', '--json'], connection);
      const removal = JSON.parse(removed.out) as { path: string; branchRetained: boolean };
      const preflight = JSON.parse(removed.err) as { phase: string; decision: { path: string } };
      const after = await subject.runFy(['worktree', 'ls', '--json'], connection);
      const reforked = await subject.runFy(
        [
          'worktree',
          'fork',
          'feature/e2e',
          '--from',
          join(source, 'packages', 'cli'),
          '--session',
          'e2e-session',
          '--json',
        ],
        connection,
      );
      const replacement = JSON.parse(reforked.out) as { worktree: WorktreeRow; cwd: string };
      const replaced = await subject.runFy(['worktree', 'ls', '--json'], connection);

      // Assert — an empty registry is an empty answer, not a 404
      should(empty.code).equal(0);
      should(empty.out).containEql('No managed worktrees');
      should(empty.err).not.containEql('unknown_route');

      // …the fork really made a checkout, and preserved the subdirectory the caller stood in
      should(forked.code).equal(0);
      should(created.worktree.branch).equal('feature/e2e');
      should(created.cwd).equal(join(created.worktree.path, 'packages', 'cli'));
      should(created.worktree.relativeCwd).equal(join('packages', 'cli'));
      should(await git(created.worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD')).equal('feature/e2e\n');

      // …the list is a live refresh over the persisted record, not a replay of it
      should(listed.code).equal(0);
      should(rows).have.length(1);
      should(rows[0]?.path).equal(created.worktree.path);
      should(rows[0]?.live?.head).equal(created.worktree.initialHead);
      should(rows[0]?.live?.status).match({ staged: false, unstaged: false, untracked: false });
      should(rows[0]?.removal?.removable).be.true();

      // …the check agrees with it, and the removal really destroys the checkout
      should(checked.code).equal(0);
      should((JSON.parse(checked.out) as { removable: boolean }).removable).be.true();
      should(removed.code).equal(0);
      should(removal).match({ path: created.worktree.path, branchRetained: true });
      should(preflight).match({ phase: 'preflight', decision: { path: created.worktree.path } });
      should(await Bun.file(join(created.worktree.path, 'packages', 'cli', 'README.md')).exists()).be.false();

      // …and the completed incarnation survives as a tombstone until a deliberate same-session,
      // same-branch fork replaces it with the new live incarnation at that deterministic path
      const remaining = (JSON.parse(after.out) as { worktrees: WorktreeRow[] }).worktrees;
      should(remaining).have.length(1);
      should(remaining[0]?.removedAt).be.a.String();
      should(after.out).not.containEql('unknown_route');
      should(reforked.code).equal(0);
      should(replacement.worktree.path).equal(created.worktree.path);
      const replacementRows = (JSON.parse(replaced.out) as { worktrees: WorktreeRow[] }).worktrees;
      should(replacementRows).have.length(1);
      should(replacementRows[0]?.path).equal(created.worktree.path);
      should(replacementRows[0]?.removedAt).be.undefined();
      should(replacementRows[0]?.live?.head).be.a.String();
    });
  }, 120_000);

  it('should refuse to destroy work the caller has not consented to losing', async () => {
    await withE2eEnvironment(async subject => {
      // Arrange
      const daemon = await compiledDaemon(subject);
      const source = await repository(subject);
      await subject.startDaemon({
        command: [daemon, '--host', '127.0.0.1', '--port', String(subject.ports.api), '--log-level', 'error'],
        readyUrl: subject.httpUrl('/healthz'),
        timeoutMs: 30_000,
      });
      const connection = { FY_URL: subject.httpUrl() };
      const forked = await subject.runFy(['worktree', 'fork', 'feature/dirty', '--from', source, '--json'], connection);
      const created = JSON.parse(forked.out) as { worktree: WorktreeRow };
      await writeFile(join(created.worktree.path, 'packages', 'cli', 'README.md'), '# edited by an agent\n');

      // Act
      const refused = await subject.runFy(['worktree', 'rm', created.worktree.path, '--yes'], connection);
      const forced = await subject.runFy(['worktree', 'rm', created.worktree.path, '--force'], connection);
      const consented = await subject.runFy(
        ['worktree', 'rm', created.worktree.path, '--yes', '--discard-changes'],
        connection,
      );

      // Assert — the refusal names the flag, there is no blanket force, and the named flag works
      should(refused.code).not.equal(0);
      should(refused.err).containEql('unstaged_changes');
      should(refused.err).containEql('--discard-changes');
      should(forced.code).not.equal(0);
      should(forced.err).containEql('--force');
      should(consented.code).equal(0);
      should(await Bun.file(join(created.worktree.path, 'packages', 'cli', 'README.md')).exists()).be.false();
    });
  }, 120_000);
});
