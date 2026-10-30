// Realworld: asserts wall-clock speed; the outcome depends on the machine, not the code.
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
  it('stops a manager that outlives its deadline and returns what it had said', async () => {
    const path = await manager('echo "downloading"\nexec sleep 30\n');
    const started = Date.now();
    const result = await runPackageInstall({ executable: path, args: [], environment, timeoutMs: 300 });
    should(result).eql({ kind: 'timed-out', tail: ['downloading'] });
    should(Date.now() - started).be.below(5_000);
  });

  it('returns soon after the manager exits even when a grandchild still holds its output open', async () => {
    const path = await manager('sleep 3 &\necho "done"\nexit 0\n');
    const started = Date.now();
    const result = await runPackageInstall({ executable: path, args: [], environment, timeoutMs: 10_000 });
    should(result).containEql({ kind: 'exited', code: 0 });
    should(Date.now() - started).be.below(5_000);
  });
});
