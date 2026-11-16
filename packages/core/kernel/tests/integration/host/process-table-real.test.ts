/**
 * `kernel.processes`' table on THIS machine: the real `/proc` (or the real `ps`, asked as macOS asks it), with the
 * daemon's own uid. The test starts its own `sleep` as the only other process it asks about, and signals nothing else.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostProcessTable } from '../../../host/adapters/process-table.ts';

const children: ReturnType<typeof Bun.spawn>[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

const uid = process.getuid?.() ?? 0;
const linux = process.platform === 'linux';

function sleeper(marker: string) {
  const child = Bun.spawn(['sleep', '30'], {
    env: { ...process.env, [marker]: 'yes' },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  children.push(child);
  return child;
}

describe.skipIf(!linux)('the process table on the real /proc', () => {
  const table = () => hostProcessTable({ platform: 'linux', uid, self: process.pid, parent: process.ppid });

  test('the command line of a process of this user is read from /proc, and its owner is proved by stat', async () => {
    const child = sleeper('FY_TABLE_TEST_A');

    const line = await table().commandLine(child.pid);

    expect(line).toContain('sleep');
    expect(line).toContain('30');
  });

  test('a pid that is not there has no command line', async () => {
    expect(await table().commandLine(2 ** 22 + 12345)).toBeUndefined();
  });

  test('the processes whose environment holds an entry are found, and this one’s is among them', async () => {
    const child = sleeper('FY_TABLE_TEST_B');

    const users = await table().withEnvironment(['FY_TABLE_TEST_B=yes']);

    expect(users).toContain(child.pid);
    expect(users).not.toContain(process.pid);
  });

  test('the daemon and every ancestor it can read are protected', async () => {
    const guarded = await table().protectedPids();

    expect(guarded.has(process.pid)).toBe(true);
    expect(guarded.has(process.ppid)).toBe(true);
    expect(guarded.has(1)).toBe(true);
  });

  test('an ancestor whose stat cannot be read ends the walk without a throw', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'fy-proc-'));
    folders.push(empty);

    const guarded = await hostProcessTable({
      platform: 'linux',
      uid,
      self: 4242,
      parent: 4243,
      procRoot: empty,
    }).protectedPids();

    expect([...guarded].sort()).toEqual([0, 1, 4242, 4243].sort());
  });

  test('a SIGTERM reaches a process of this user; a second one finds it gone', async () => {
    const child = sleeper('FY_TABLE_TEST_C');

    const first = await table().sigterm(child.pid);
    await child.exited;
    const second = await table().sigterm(child.pid);

    expect(first).toBe('signalled');
    expect(second).toBe('gone');
  });

  test('a failure that is not an errno is a refusal, not a throw', async () => {
    const refusing = hostProcessTable({
      platform: 'linux',
      uid,
      self: process.pid,
      parent: process.ppid,
      kill: () => {
        throw new Error('the signal was blocked');
      },
    });

    expect(await refusing.sigterm(1234)).toBe('refused');
  });
});

describe.skipIf(Bun.which('ps') === null)('the process table asked of the real ps, the way macOS asks it', () => {
  const table = () =>
    hostProcessTable({
      platform: 'darwin',
      uid,
      self: process.pid,
      parent: process.ppid,
      locatePs: async () => Bun.which('ps') ?? undefined,
    });

  test('a process of this user has its command line from ps, with its uid proved', async () => {
    const child = sleeper('FY_TABLE_TEST_D');

    const line = await table().commandLine(child.pid);

    expect(line).toContain('sleep');
  });

  test('the parent of a process is read from ps, and the walk goes up from it', async () => {
    const guarded = await table().protectedPids();

    expect(guarded.has(process.pid)).toBe(true);
    expect(guarded.has(process.ppid)).toBe(true);
  });
});
