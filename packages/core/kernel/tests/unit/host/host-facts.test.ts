/** TT kernel.hostFacts: narrow /proc and /sys reads, only for a manifest that declares them. */
import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { nodeHostFacts, undeclaredHostFacts } from '../../../host/adapters/host-facts.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';

const nowhere = nodeHostFacts({ proc: '/nonexistent-proc', sys: '/nonexistent-sys' });

describe('TT kernel.hostFacts', () => {
  test('a pid, a descriptor, a cgroup path and a device number are checked before anything is read', async () => {
    for (const read of [
      () => nowhere.procFile(0, 'stat'),
      () => nowhere.procFile(1.5, 'stat'),
      () => nowhere.procFdLink(1, '../../etc/passwd'),
      () => nowhere.procTaskChildren(1, -1),
      () => nowhere.procWorkingDirectory(0),
      () => nowhere.procWorkingDirectory(-1),
      () => nowhere.procWorkingDirectory(1.5),
      () => nowhere.procWorkingDirectory('1' as unknown as number),
      () => nowhere.cgroupFile('../../etc', 'cpu.max'),
      () => nowhere.cgroupChildren('user.slice/..'),
      () => nowhere.blockScheduler(-1, 0),
    ])
      await expect(read()).rejects.toThrow(RangeError);
    // a well-formed request reaches the (absent) file system and fails as the read it replaces did
    await expect(nowhere.procFile('self', 'cgroup')).rejects.toThrow(/ENOENT/);
  });

  test('the working folder of a process that is not there is undefined, not a fault', async () => {
    expect(await nowhere.procWorkingDirectory(4242)).toBeUndefined();
  });

  test('diskFreeBytes answers a number for a folder that is there, undefined for one that is not, and refuses a relative path', async () => {
    const free = await nowhere.diskFreeBytes(tmpdir());
    expect(typeof free).toBe('number');
    expect(free).toBeGreaterThan(0);
    expect(await nowhere.diskFreeBytes('/nonexistent-folder-for-statfs')).toBeUndefined();
    await expect(nowhere.diskFreeBytes('relative/folder')).rejects.toBeInstanceOf(RangeError);
  });

  test('darwin has no procfs: the answer is undefined without a read, a bad pid still refuses', async () => {
    const mac = nodeHostFacts({ proc: '/nonexistent-proc', sys: '/nonexistent-sys', platform: 'darwin' });
    expect(mac.platform).toBe('darwin');
    expect(await mac.procWorkingDirectory(1)).toBeUndefined();
    await expect(mac.procWorkingDirectory(0)).rejects.toBeInstanceOf(RangeError);
  });

  test('a plugin without permissions.hostFacts reads nothing; one with it gets the host’s facts', async () => {
    const facts = {
      ...undeclaredHostFacts('x', nowhere),
      pids: async () => [1, 2],
      procWorkingDirectory: async (pid: number) => (pid === 1 ? '/work/one' : undefined),
    };
    const seen: Record<string, () => Promise<readonly number[]>> = {};
    const cwd: Record<string, () => Promise<string | undefined>> = {};
    const half = (id: string, hostFacts?: true) =>
      implementDaemon(
        definePlugin({
          id,
          title: id,
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: [],
          ...(hostFacts === undefined ? {} : { permissions: { hostFacts } }),
        }),
        {
          build: ctx => {
            seen[id] = () => ctx.kernel.hostFacts.pids();
            cwd[id] = () => ctx.kernel.hostFacts.procWorkingDirectory(1);
            return {};
          },
        },
      );
    const host = await testHost({ plugins: [half('terminals', true), half('other')], hostFacts: facts });
    expect(await seen['terminals']?.()).toEqual([1, 2]);
    await expect(seen['other']?.() ?? Promise.resolve()).rejects.toThrow('did not declare permissions.hostFacts');
    expect(await cwd['terminals']?.()).toBe('/work/one');
    await expect(cwd['other']?.() ?? Promise.resolve()).rejects.toThrow('did not declare permissions.hostFacts');
    await host.stop();
  });
});
