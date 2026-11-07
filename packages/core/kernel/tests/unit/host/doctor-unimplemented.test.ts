import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { bootHost, type HostOptions } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';

const plugin = definePlugin({
  id: 'checked',
  title: 'Checked',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  doctor: ['checked-ok', 'checked-unbuilt'],
});

test('G158 a declared doctor check with no run still boots, and fy doctor names it as a failure', async () => {
  const root = await mkdtemp(`${tmpdir()}/doctor-unimplemented-`);
  const home = `${root}/home`;
  const adapters: HostOptions['adapters'] = {
    ...realAdapters(home, () => {}, { binary: 'fy' }),
    clock: fixedClock(),
    homeLock: async () => ({ release: async () => {} }),
  };
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters,
    implementations: [
      implementDaemon(plugin, {
        build: () => ({ doctor: { 'checked-ok': async () => ({ state: 'ok', detail: 'fine' }) } }),
      }),
    ],
  });
  try {
    if (outcome.kind !== 'running') throw new Error(outcome.sentence);
    expect(outcome.host.plugins.get('checked')?.status).toBe('serving');
    const lines = await outcome.host.doctor();
    expect(lines).toContainEqual({ plugin: 'checked', check: 'checked-ok', state: 'ok', detail: 'fine' });
    expect(lines).toContainEqual({
      plugin: 'checked',
      check: 'checked-unbuilt',
      state: 'fail',
      detail: 'The check checked-unbuilt has no implementation.',
    });
  } finally {
    if (outcome.kind === 'running') await outcome.host.stop();
    await rm(root, { recursive: true, force: true });
  }
});
