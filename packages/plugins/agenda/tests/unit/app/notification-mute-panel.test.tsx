/**
 * Settings › This device › Mute, under the boundary a real device panel is drawn in: no shell, no machine, no client
 * (`DevicePanels` mounts a `device.settings` contribution under `WithoutShell`). The machines come from `useEveryDaemon`
 * and each row flips only its own machine's entry of the notification filter, the document the worker reads.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { deviceViewHarness, ensureDom, fakeReachRow, interact, type Mounted, mount } from '@ferretry/app/testing';
import { useAppHook } from '../../../app/shell.ts';
import { machineMute } from '../../../app/lib/machine-mute.ts';
import { DeviceNotificationFilterStore } from '../../../app/lib/notification-filter.ts';
import { NotificationMutePanel } from '../../../app/views/notification-mute-panel.tsx';

ensureDom();

const HOME = `fy_daemon_${'a'.repeat(43)}`;
const DESK = `fy_daemon_${'b'.repeat(43)}`;

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const draw = async (store: DeviceNotificationFilterStore, daemons: readonly string[] = [HOME, DESK]) => {
  const harness = deviceViewHarness({ plugin: 'agenda', fragments: [] });
  harness.setRows(
    daemons.map(daemon => fakeReachRow({ daemon, machine: daemon === HOME ? 'Home' : 'Desk', client: {} as never })),
  );
  mounted = await mount(
    <harness.Harness>
      <NotificationMutePanel muteOf={daemon => machineMute(daemon, () => store)} />
    </harness.Harness>,
  );
  return mounted.container;
};

const rowOf = (root: HTMLElement, daemon: string) =>
  root.querySelector<HTMLElement>(`[data-mute-machine="${daemon}"] [data-machine-mute]`);

describe('NotificationMutePanel', () => {
  it('is drawn where a device panel is drawn: no shell, so no app hook is readable there', async () => {
    let read: unknown = 'unread';
    function Probe() {
      read = useAppHook(HOME, 'access.machine-mute');
      return null;
    }
    const harness = deviceViewHarness({ plugin: 'agenda', fragments: [] });
    mounted = await mount(
      <harness.Harness>
        <Probe />
      </harness.Harness>,
    );
    expect(read).toBeUndefined();
  });

  it('draws one Mute per machine under that boundary', async () => {
    const root = await draw(new DeviceNotificationFilterStore());
    expect(root.querySelectorAll('[data-machine-mute]')).toHaveLength(2);
    expect(rowOf(root, HOME)?.textContent).toBe('Mute');
    expect(rowOf(root, DESK)?.getAttribute('aria-label')).toBe('Mute Desk');
  });

  it('draws nothing when no machine is reached', async () => {
    const root = await draw(new DeviceNotificationFilterStore(), []);
    expect(root.querySelectorAll('[data-machine-mute]')).toHaveLength(0);
  });

  it('pressing a row mutes only that machine, and pressing again unmutes it', async () => {
    const store = new DeviceNotificationFilterStore();
    const root = await draw(store);
    await interact(() => rowOf(root, HOME)?.click());
    expect(store.get().machines).toEqual({ [HOME]: false });
    expect(rowOf(root, HOME)?.textContent).toBe('Unmute');
    expect(rowOf(root, HOME)?.getAttribute('aria-pressed')).toBe('true');
    expect(rowOf(root, DESK)?.textContent).toBe('Mute');
    await interact(() => rowOf(root, HOME)?.click());
    expect(store.get().machines[HOME]).toBe(true);
    expect(rowOf(root, HOME)?.textContent).toBe('Mute');
    expect(store.get().machines[DESK]).toBeUndefined();
  });

  it('keeps a machine muted in the store the worker reads when the panel is drawn again', async () => {
    const store = new DeviceNotificationFilterStore();
    const first = await draw(store);
    await interact(() => rowOf(first, DESK)?.click());
    await mounted?.unmount();
    const again = await draw(store);
    expect(rowOf(again, DESK)?.textContent).toBe('Unmute');
    expect(rowOf(again, HOME)?.textContent).toBe('Mute');
  });
});
