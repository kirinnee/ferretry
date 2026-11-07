/** TT kernel.hostFacts: narrow /proc and /sys reads, only for a manifest that declares them. */
import { describe, expect, test } from 'bun:test';
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
      () => nowhere.cgroupFile('../../etc', 'cpu.max'),
      () => nowhere.cgroupChildren('user.slice/..'),
      () => nowhere.blockScheduler(-1, 0),
    ])
      await expect(read()).rejects.toThrow(RangeError);
    // a well-formed request reaches the (absent) file system and fails as the read it replaces did
    await expect(nowhere.procFile('self', 'cgroup')).rejects.toThrow(/ENOENT/);
  });

  test('a plugin without permissions.hostFacts reads nothing; one with it gets the host’s facts', async () => {
    const facts = { ...undeclaredHostFacts('x', nowhere), pids: async () => [1, 2] };
    const seen: Record<string, () => Promise<readonly number[]>> = {};
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
            return {};
          },
        },
      );
    const host = await testHost({ plugins: [half('terminals', true), half('other')], hostFacts: facts });
    expect(await seen['terminals']?.()).toEqual([1, 2]);
    await expect(seen['other']?.() ?? Promise.resolve()).rejects.toThrow('did not declare permissions.hostFacts');
    await host.stop();
  });
});
