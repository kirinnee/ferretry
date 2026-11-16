/** TT: the real adapter reads exactly the file each method names, from a fixture /proc and /sys tree. */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { nodeHostFacts } from '../../../host/adapters/host-facts.ts';
import type { CgroupFile, ProcPidFile, ProcSystemFile } from '../../../contract/ports.ts';

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function tree() {
  const root = await mkdtemp(`${tmpdir()}/fy-facts-`);
  roots.push(root);
  const proc = `${root}/proc`;
  const sys = `${root}/sys`;
  await mkdir(`${proc}/42/task/42`, { recursive: true });
  await mkdir(`${proc}/42/fd`, { recursive: true });
  await mkdir(`${proc}/self`, { recursive: true });
  await mkdir(`${proc}/net`, { recursive: true });
  await mkdir(`${proc}/notapid`, { recursive: true });
  await writeFile(`${proc}/42/stat`, '42 (sh) S 1 ...');
  await writeFile(`${proc}/42/task/42/children`, '43 44 ');
  await writeFile(`${proc}/self/cgroup`, '0::/user.slice\n');
  await writeFile(`${proc}/net/tcp`, 'sl local\n');
  await symlink('/dev/pts/3', `${proc}/42/fd/0`);
  await symlink('/usr/bin/sh', `${proc}/42/exe`);
  await symlink('/work/project', `${proc}/42/cwd`);
  await mkdir(`${proc}/43`, { recursive: true });
  await symlink('/work/gone (deleted)', `${proc}/43/cwd`);
  await mkdir(`${sys}/fs/cgroup/user.slice`, { recursive: true });
  await writeFile(`${sys}/fs/cgroup/user.slice/cpu.weight`, '100\n');
  await mkdir(`${sys}/block/sda/sda1`, { recursive: true });
  await mkdir(`${sys}/block/sda/queue`, { recursive: true });
  await writeFile(`${sys}/block/sda/queue/scheduler`, 'none [mq-deadline]\n');
  await mkdir(`${sys}/dev/block`, { recursive: true });
  await symlink(`${sys}/block/sda/sda1`, `${sys}/dev/block/8:1`);
  return nodeHostFacts({ proc, sys });
}

describe.skipIf(process.platform !== 'linux')('TT procWorkingDirectory on the real /proc', () => {
  test('a child process we spawned answers its folder; once it is gone the answer is undefined', async () => {
    const work = await mkdtemp(`${tmpdir()}/fy-cwd-`);
    roots.push(work);
    const child = spawn('sleep', ['30'], { cwd: work, stdio: 'ignore' });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    try {
      expect(child.pid).toBeDefined();
      const facts = nodeHostFacts();
      expect(await facts.procWorkingDirectory(child.pid as number)).toBe(await realpath(work));
      expect(await facts.procWorkingDirectory(process.pid)).toBe(await realpath(process.cwd()));
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
    expect(await nodeHostFacts().procWorkingDirectory(child.pid as number)).toBeUndefined();
  });

  test('a child whose folder was removed answers undefined, not the "(deleted)" text', async () => {
    const work = await mkdtemp(`${tmpdir()}/fy-cwd-gone-`);
    const child = spawn('sleep', ['30'], { cwd: work, stdio: 'ignore' });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    try {
      await rm(work, { recursive: true, force: true });
      expect(await nodeHostFacts().procWorkingDirectory(child.pid as number)).toBeUndefined();
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
  });
});

describe('TT nodeHostFacts on a fixture tree', () => {
  test('TT runtime file allowlists refuse traversal and undeclared interface files', async () => {
    const facts = await tree();
    for (const file of ['../net/tcp', 'fd/0', 'exe', '/stat', '', 'stat\0', 1, null])
      await expect(facts.procFile(42, file as ProcPidFile)).rejects.toBeInstanceOf(RangeError);
    for (const file of ['42/stat', '../proc/42/stat', 'sys/kernel/hostname', '', {}, null])
      await expect(facts.procSystemFile(file as ProcSystemFile)).rejects.toBeInstanceOf(RangeError);
    for (const file of ['../user.slice/cpu.weight', 'cgroup.subtree_control', '', {}, null])
      await expect(facts.cgroupFile('user.slice', file as CgroupFile)).rejects.toBeInstanceOf(RangeError);
  });

  test('TT runtime pid and cgroup path validation rejects non-numbers and unsafe segments', async () => {
    const facts = await tree();
    for (const pid of [0, -1, 1.5, NaN, Infinity, '42', '../42', null, {}, Number.MAX_SAFE_INTEGER + 1]) {
      const value = pid as number;
      for (const read of [
        () => facts.procFile(value, 'stat'),
        () => facts.procTasks(value),
        () => facts.procTaskChildren(42, value),
        () => facts.procFds(value),
        () => facts.procFdLink(value, '0'),
        () => facts.procFdReach(value, '0'),
        () => facts.procExecutable(value),
        () => facts.procWorkingDirectory(value),
      ])
        await expect(read()).rejects.toBeInstanceOf(RangeError);
    }
    for (const path of ['..', 'user.slice/../user.slice', '.', 'x\0y', {}, null]) {
      await expect(facts.cgroupFile(path as string, 'cpu.weight')).rejects.toBeInstanceOf(RangeError);
      await expect(facts.cgroupChildren(path as string)).rejects.toBeInstanceOf(RangeError);
    }
  });

  test('process reads', async () => {
    const facts = await tree();
    // `readdir` order is the filesystem's, not a contract: `pids()` is "the numeric entries of /proc", so compare as a set.
    expect([...(await facts.pids())].sort((a, b) => a - b)).toEqual([42, 43]);
    expect(await facts.procFile(42, 'stat')).toStartWith('42 (sh)');
    expect(await facts.procFile('self', 'cgroup')).toBe('0::/user.slice\n');
    expect(await facts.procTasks(42)).toEqual(['42']);
    expect(await facts.procTaskChildren(42, 42)).toBe('43 44 ');
    expect(await facts.procFds(42)).toEqual(['0']);
    expect(await facts.procFdLink(42, '0')).toBe('/dev/pts/3');
    expect(await facts.procExecutable(42)).toBe('/usr/bin/sh');
    expect(await facts.procWorkingDirectory(42)).toBe('/work/project');
    expect(await facts.procSystemFile('net/tcp')).toBe('sl local\n');
  });

  test('the working folder: a removed folder and a process that is not there both answer undefined', async () => {
    const facts = await tree();
    expect(await facts.procWorkingDirectory(43)).toBeUndefined();
    expect(await facts.procWorkingDirectory(44)).toBeUndefined();
  });

  test('cgroup and block-device reads; a partition reads its parent disk’s scheduler', async () => {
    const facts = await tree();
    expect(await facts.cgroupFile('user.slice', 'cpu.weight')).toBe('100\n');
    expect(await facts.cgroupChildren('')).toEqual(['user.slice']);
    expect(await facts.blockScheduler(8, 1)).toEqual({ device: 'sda', scheduler: 'none [mq-deadline]\n' });
  });
});
