import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { bootHost, type HostOptions, type RunningHost } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';

const homes: string[] = [];
const running: RunningHost[] = [];
afterEach(async () => {
  for (const host of running.splice(0)) await host.stop();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture(): Promise<HostOptions> {
  const home = await mkdtemp(`${tmpdir()}/fy-boot-lock-`);
  homes.push(home);
  return { home, version: '5.0.0', implementations: [], adapters: realAdapters(home, () => {}, { binary: 'fy' }) };
}
async function started(options: HostOptions) {
  const boot = await bootHost(options);
  if (boot.kind !== 'running') throw new Error(boot.sentence);
  running.push(boot.host);
  return boot.host;
}

test('G57 production boot refuses a second daemon and releases the home lock on stop', async () => {
  const options = await fixture();
  const first = await started(options);
  const second = await bootHost(options);
  if (second.kind === 'running') running.push(second.host);
  expect(second.kind).toBe('refused');
  if (second.kind === 'refused') expect(second.sentence).toContain('fy daemon adopt');
  await first.stop();
  await started(options);
});

test('G57 production boot releases the home lock on a refused build or thrown listener', async () => {
  const options = await fixture();
  const core = definePlugin({ id: 'gate', title: 'Gate', version: '5.0.0', api: 5, core: true, kinds: [] });
  const refusing = await bootHost({
    ...options,
    implementations: [
      implementDaemon(core, {
        build: () => {
          throw new Error('fixture');
        },
      }),
    ],
  });
  expect(refusing.kind).toBe('refused');
  await expect(
    bootHost({
      ...options,
      listen: async () => {
        throw new Error('fixture listener');
      },
    }),
  ).rejects.toThrow('fixture listener');
  await started(options);
});
