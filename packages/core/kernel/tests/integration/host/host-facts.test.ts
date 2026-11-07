/** TT: the real adapter reads exactly the file each method names, from a fixture /proc and /sys tree. */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { nodeHostFacts } from '../../../host/adapters/host-facts.ts';

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
  await mkdir(`${sys}/fs/cgroup/user.slice`, { recursive: true });
  await writeFile(`${sys}/fs/cgroup/user.slice/cpu.weight`, '100\n');
  await mkdir(`${sys}/block/sda/sda1`, { recursive: true });
  await mkdir(`${sys}/block/sda/queue`, { recursive: true });
  await writeFile(`${sys}/block/sda/queue/scheduler`, 'none [mq-deadline]\n');
  await mkdir(`${sys}/dev/block`, { recursive: true });
  await symlink(`${sys}/block/sda/sda1`, `${sys}/dev/block/8:1`);
  return nodeHostFacts({ proc, sys });
}

describe('TT nodeHostFacts on a fixture tree', () => {
  test('process reads', async () => {
    const facts = await tree();
    expect(await facts.pids()).toEqual([42]);
    expect(await facts.procFile(42, 'stat')).toStartWith('42 (sh)');
    expect(await facts.procFile('self', 'cgroup')).toBe('0::/user.slice\n');
    expect(await facts.procTasks(42)).toEqual(['42']);
    expect(await facts.procTaskChildren(42, 42)).toBe('43 44 ');
    expect(await facts.procFds(42)).toEqual(['0']);
    expect(await facts.procFdLink(42, '0')).toBe('/dev/pts/3');
    expect(await facts.procExecutable(42)).toBe('/usr/bin/sh');
    expect(await facts.procSystemFile('net/tcp')).toBe('sl local\n');
  });

  test('cgroup and block-device reads; a partition reads its parent disk’s scheduler', async () => {
    const facts = await tree();
    expect(await facts.cgroupFile('user.slice', 'cpu.weight')).toBe('100\n');
    expect(await facts.cgroupChildren('')).toEqual(['user.slice']);
    expect(await facts.blockScheduler(8, 1)).toEqual({ device: 'sda', scheduler: 'none [mq-deadline]\n' });
  });
});
