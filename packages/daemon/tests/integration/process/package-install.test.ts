/**
 * The package-manager runner, against real processes.
 *
 * Every property here is one a fake cannot establish: stdin really is closed so a prompt cannot wait,
 * both streams really are read into one bounded tail, a deadline really does end a run whose manager
 * hangs, and a grandchild holding the pipe open after the manager exits really does not hold the run.
 * The "managers" are shell scripts written to a temporary directory and really run.
 */
import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { runPackageInstall } from '../../../src/adapters/process/package-install.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

/** Write an executable shell script standing in for a package manager, and return its path. */
async function manager(body: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-package-install-'));
  temporaryDirectories.push(root);
  const path = join(root, 'manager.sh');
  await writeFile(path, `#!/bin/sh\n${body}`, 'utf8');
  await chmod(path, 0o700);
  return path;
}

const environment = { PATH: '/usr/bin:/bin' };

describe('runPackageInstall', () => {
  it('passes the declared arguments and environment and reports the exit code with both streams', async () => {
    const path = await manager('echo "args: $*"\necho "marker: $FY_MARK" >&2\nexit 3\n');
    const result = await runPackageInstall({
      executable: path,
      args: ['install', '-g', 'pkg'],
      environment: { ...environment, FY_MARK: 'here' },
      timeoutMs: 10_000,
    });
    should(result.kind).equal('exited');
    if (result.kind !== 'exited') return;
    should(result.code).equal(3);
    should([...result.tail].sort()).eql(['args: install -g pkg', 'marker: here']);
  });

  it('closes stdin, so a manager asking a question reads end-of-file instead of waiting', async () => {
    const path = await manager('if read answer; then echo "got $answer"; else echo "no input"; exit 1; fi\n');
    should(await runPackageInstall({ executable: path, args: [], environment, timeoutMs: 10_000 })).eql({
      kind: 'exited',
      code: 1,
      tail: ['no input'],
    });
  });

  it('keeps only the last forty lines, including a final line with no newline', async () => {
    const path = await manager('i=1\nwhile [ $i -le 60 ]; do echo "line $i"; i=$((i+1)); done\nprintf "last"\n');
    const result = await runPackageInstall({ executable: path, args: [], environment, timeoutMs: 10_000 });
    should(result.kind === 'exited' && result.tail.length).equal(40);
    should(result.kind === 'exited' && result.tail.at(0)).equal('line 22');
    should(result.kind === 'exited' && result.tail.at(-1)).equal('last');
  });

  it('stops a manager that outlives its deadline and returns what it had said', async () => {
    const path = await manager('echo "downloading"\nexec sleep 30\n');
    const result = await runPackageInstall({ executable: path, args: [], environment, timeoutMs: 300 });
    should(result).eql({ kind: 'timed-out', tail: ['downloading'] });
  });

  it('returns soon after the manager exits even when a grandchild still holds its output open', async () => {
    const path = await manager('sleep 3 &\necho "done"\nexit 0\n');
    const result = await runPackageInstall({ executable: path, args: [], environment, timeoutMs: 10_000 });
    should(result).containEql({ kind: 'exited', code: 0 });
  });

  it('reports a manager that cannot be started instead of throwing', async () => {
    const result = await runPackageInstall({
      executable: join(tmpdir(), 'fy-no-such-manager', 'npm'),
      args: [],
      environment,
      timeoutMs: 10_000,
    });
    should(result.kind).equal('not-started');
    should(result.kind === 'not-started' && result.reason.length).be.above(0);
  });
});
