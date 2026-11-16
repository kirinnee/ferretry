import { afterEach, describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import {
  DeviceProvider,
  type DevicePaired,
  NO_INSTALL_PROMPT,
  useDevicePaired,
} from '../../../src/shell/device-context.tsx';
import { useNoReaches } from '../../../src/shell/every-daemon.ts';
import type { NoReach } from '../../../src/shell/plugin-identity.tsx';
import { deviceViewHarness } from '../../../src/testing/device-view.tsx';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import { AddressTaker } from '../../../src/router/address.ts';
import { HandOffs } from '../../../src/shell/hand-off.ts';
import { interact, type Mounted, mount } from '../../support/dom.ts';

/**
 * THE PAIRED MACHINES A DEVICE VIEW SEES (R2-m1, shell contract S9 / MA4): ids, titles and the selected id — never an
 * address, a carrier set or a device id — and only where the shell gave the plugin a `reach`.
 */

const A = `fy_daemon_${'a'.repeat(43)}`;
const B = `fy_daemon_${'b'.repeat(43)}`;

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

function harnessOf() {
  const harness = deviceViewHarness({ plugin: 'agenda', fragments: [] });
  harness.setPaired([A, B], B);
  return harness;
}

function Probe({ into }: { readonly into: { value?: DevicePaired; renders: number } }): ReactNode {
  into.value = useDevicePaired();
  into.renders += 1;
  return null;
}

describe('useDevicePaired', () => {
  test('R2-m1 a plugin’s device view sees only the paired ids, their titles and the selected id', async () => {
    const harness = harnessOf();
    const seen: { value?: DevicePaired; renders: number } = { renders: 0 };
    view = await mount(
      <harness.Harness>
        <Probe into={seen} />
      </harness.Harness>,
    );
    expect(seen.value?.selected).toBe(B);
    expect(seen.value?.daemons.map(machine => machine.daemon).sort()).toEqual([A, B]);
    for (const machine of seen.value?.daemons ?? []) expect(Object.keys(machine).sort()).toEqual(['daemon', 'title']);
    expect(Object.keys(seen.value ?? {}).sort()).toEqual(['daemons', 'selected']);
    // Nothing that says where a machine is or how to reach it reaches the view.
    const text = JSON.stringify(seen.value);
    expect(text).not.toContain('daemon.test');
    expect(text).not.toContain('device-');
    expect(text).not.toContain('carriers');
    expect(text).not.toContain('address');
    expect(text).not.toContain('deviceId');
  });

  test('R2-m1 the title is the owner’s label, else the machine name', async () => {
    const list = new DaemonList({ storage: memoryStore(), now: () => 1 });
    list.add({ daemon: A, machine: 'laptop', deviceId: 'd', address: 'https://x.test' });
    list.add({ daemon: B, machine: 'desk', deviceId: 'd', address: 'https://y.test', label: 'Home desk' });
    const device = {
      theme: new ThemePreferenceStore(memoryStore()),
      systemDark: false,
      install: NO_INSTALL_PROMPT,
      address: new AddressTaker([], {
        location: { pathname: '/', search: '', hash: '' },
        history: { state: null, replaceState: () => {} } as unknown as Pick<History, 'state' | 'replaceState'>,
        addEventListener: () => {},
      }),
      handOffs: new HandOffs(() => undefined, { now: Date.now, after: () => {} }),
      daemons: list,
    };
    const harness = deviceViewHarness({ plugin: 'agenda', fragments: [] });
    const seen: { value?: DevicePaired; renders: number } = { renders: 0 };
    // The harness builds its own device context; a second provider below it carries this list.
    view = await mount(
      <harness.Harness>
        <DeviceProvider value={device}>
          <Probe into={seen} />
        </DeviceProvider>
      </harness.Harness>,
    );
    expect(Object.fromEntries((seen.value?.daemons ?? []).map(machine => [machine.daemon, machine.title]))).toEqual({
      [A]: 'laptop',
      [B]: 'Home desk',
    });
  });

  test('R2-m1 a daemon-less screen — the kind a stranger’s link opens — gets no machine', async () => {
    const harness = harnessOf();
    const seen: { value?: DevicePaired; renders: number } = { renders: 0 };
    view = await mount(
      <harness.Harness place="daemonless" screen="landing">
        <Probe into={seen} />
      </harness.Harness>,
    );
    expect(seen.value).toEqual({ daemons: [], selected: null });
  });

  test('R2-m1 outside any place or shell there is no machine either', async () => {
    const seen: { value?: DevicePaired; renders: number } = { renders: 0 };
    view = await mount(<Probe into={seen} />);
    expect(seen.value).toEqual({ daemons: [], selected: null });
  });

  test('a per-daemon view is served too, live, and the same object is held while the list does not move', async () => {
    const harness = harnessOf();
    const seen: { value?: DevicePaired; renders: number } = { renders: 0 };
    view = await mount(
      <harness.Harness place="daemon">
        <Probe into={seen} />
      </harness.Harness>,
    );
    const first = seen.value;
    expect(first?.daemons).toHaveLength(2);
    const renders = seen.renders;
    await interact(() => harness.setRows([]));
    expect(seen.value).toBe(first);
    expect(seen.renders).toBe(renders);
    await interact(() => harness.setPaired([A]));
    expect(seen.value?.daemons.map(machine => machine.daemon)).toEqual([A]);
    expect(seen.value?.selected).toBe(A);
  });
});

describe('useNoReaches', () => {
  const waiting: NoReach = { waiting: true, line: 'Checking what this daemon offers…' };
  const off: NoReach = { waiting: false, line: 'Agenda is off on this daemon.' };
  const PAIRED = [A, B];

  function Reasons({ into }: { readonly into: { value?: ReadonlyMap<string, NoReach> } }): ReactNode {
    into.value = useNoReaches(PAIRED);
    return null;
  }

  test('answers the shell’s reason for each machine without a row, and moves when a reason changes', async () => {
    const harness = harnessOf();
    harness.setNoReach({ [B]: waiting });
    const seen: { value?: ReadonlyMap<string, NoReach> } = {};
    view = await mount(
      <harness.Harness>
        <Reasons into={seen} />
      </harness.Harness>,
    );
    expect([...(seen.value ?? [])]).toEqual([[B, waiting]]);
    const held = seen.value;
    // The same answer again is the same map.
    await interact(() => harness.setNoReach({ [B]: { ...waiting } }));
    expect(seen.value).toBe(held);
    await interact(() => harness.setNoReach({ [B]: off }));
    expect([...(seen.value ?? [])]).toEqual([[B, off]]);
    await interact(() => harness.setNoReach({}));
    expect(seen.value?.size).toBe(0);
  });

  test('answers nothing on a daemon-less screen and outside a shell', async () => {
    const harness = harnessOf();
    harness.setNoReach({ [B]: off });
    const seen: { value?: ReadonlyMap<string, NoReach> } = {};
    view = await mount(
      <harness.Harness place="daemonless" screen="landing">
        <Reasons into={seen} />
      </harness.Harness>,
    );
    expect(seen.value?.size).toBe(0);
    await view.unmount();
    view = await mount(<Reasons into={seen} />);
    expect(seen.value?.size).toBe(0);
  });
});
