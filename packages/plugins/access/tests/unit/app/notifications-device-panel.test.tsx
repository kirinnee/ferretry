import { afterEach, describe, expect, it } from 'bun:test';
import { deviceViewHarness, fakeReachRow } from '@ferretry/app/testing';
import type { DaemonReach } from '@ferretry/app';
import { NotificationsDevicePanel } from '../../../app/surfaces.tsx';
import { browser, deviceOf, machine } from '../../support/app/push.ts';
import { interact, type Mounted, mount } from '../../support/app/dom.ts';

/**
 * ACCESS'S DEVICE-LEVEL NOTIFICATIONS PANEL (shell contract S4, R1 M2/M3): drawn with NO machine and no client, under a
 * device-panel identity with the rows the shell hands it. ONE list, a row per machine; each row reads and writes only
 * through ITS OWN row's client, a machine this device may not use is not listed, and the rows carry the machine's name.
 */

const refusal = { kind: 'refused', refusal: 'not-granted' } as const;

/** A row whose push route this device may not use (the daemon said `not-granted`). */
const refusedRow = (row: DaemonReach): DaemonReach => Object.freeze({ ...row, authorityOf: () => refusal });

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};

const draw = async (rows: readonly DaemonReach[], permission: 'default' | 'granted' = 'granted') => {
  const harness = deviceViewHarness({ plugin: 'access', fragments: [] });
  harness.setRows(rows);
  const { host, asked } = browser(permission);
  view = await mount(
    <harness.Harness>
      <NotificationsDevicePanel host={host} />
    </harness.Harness>,
  );
  await settle();
  return { harness, asked };
};

const rowEl = (daemon: string): Element | null =>
  view?.container.querySelector(`[data-machine-notification="${daemon}"]`) ?? null;
const switchOf = (daemon: string): HTMLElement => rowEl(daemon)?.querySelector('[role="switch"]') as HTMLElement;

describe('Access’s device-level Notifications panel', () => {
  it('draws one row per reached machine, each naming its machine (the label reaches the rows)', async () => {
    const a = machine([], 'daemon-a');
    const b = machine([deviceOf('push-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Pixel B')], 'daemon-b');
    await draw([
      fakeReachRow({ daemon: 'daemon-a', client: a.client, machine: 'laptop' }),
      fakeReachRow({ daemon: 'daemon-b', client: b.client, machine: 'desk' }),
    ]);
    expect(view?.container.querySelectorAll('[data-machine-notification]')).toHaveLength(2);
    expect(rowEl('daemon-a')?.textContent).toContain('laptop');
    expect(rowEl('daemon-b')?.textContent).toContain('desk');
    expect(rowEl('daemon-b')?.textContent).toContain('Pixel B');
    expect(view?.container.textContent).toContain('Permission: Allowed in this browser.');
  });

  it('shell S4: Enable on machine B sends POST /v1/push/subscriptions on B’s client only (each row writes through its own client)', async () => {
    const a = machine([], 'daemon-a');
    const b = machine([], 'daemon-b');
    await draw([
      fakeReachRow({ daemon: 'daemon-a', client: a.client, machine: 'laptop' }),
      fakeReachRow({ daemon: 'daemon-b', client: b.client, machine: 'desk' }),
    ]);
    await interact(() => switchOf('daemon-b').click());
    await settle();
    expect(b.calls).toContain('POST /v1/push/subscriptions');
    expect(a.calls).not.toContain('POST /v1/push/subscriptions');
    expect(a.devices).toEqual([]);
    expect(b.devices).toHaveLength(1);
  });

  it('a machine this device may not use (not-granted) is not listed, and its client is never read', async () => {
    const a = machine([], 'daemon-a');
    const b = machine([], 'daemon-b');
    await draw([
      fakeReachRow({ daemon: 'daemon-a', client: a.client, machine: 'laptop' }),
      refusedRow(fakeReachRow({ daemon: 'daemon-b', client: b.client, machine: 'desk' })),
    ]);
    expect(rowEl('daemon-a')).not.toBeNull();
    expect(rowEl('daemon-b')).toBeNull();
    expect(b.calls).toEqual([]);
  });

  it('a locked machine is listed as locked with an Unlock, and is not read', async () => {
    const a = machine([], 'daemon-a');
    await draw([fakeReachRow({ daemon: 'daemon-a', client: a.client, machine: 'laptop', locked: true })]);
    expect(rowEl('daemon-a')?.textContent).toContain('Locked — unlock laptop');
    expect(rowEl('daemon-a')?.querySelector('[data-machine-unlock]')).not.toBeNull();
    expect(a.calls).toEqual([]);
  });

  it('draws only the permissions when no machine is reached', async () => {
    await draw([]);
    expect(view?.container.querySelectorAll('[data-machine-notification]')).toHaveLength(0);
  });
});
