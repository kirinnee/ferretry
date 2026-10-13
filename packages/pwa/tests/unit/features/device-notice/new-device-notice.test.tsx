import '../../../support/dom.ts';
import { describe, expect, it } from 'bun:test';
import type { PairedDevice, PairedDevicesView } from '@ferretry/protocol';
import {
  DEVICES_LOOKED_EVENT,
  type DevicesLookedStorage,
  devicesLookedKey,
  markDevicesLooked,
} from '../../../../src/features/device-notice/devices-looked.ts';
import {
  NEW_DEVICE_REFRESH_MS,
  type NewDeviceNoticeClients,
  NewDeviceNotices,
} from '../../../../src/features/device-notice/new-device-notice.tsx';
import type { PairingClient } from '../../../../src/features/settings/add-device-api.ts';
import type { DaemonConnectionRecord } from '../../../../src/lib/connections.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../../../support/dom.ts';
import { runAsync } from '../../../support/react.ts';
import { settleUntil } from '../../../support/settle.ts';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const now = () => NOW;
const MINUTE = 60_000;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const record = (daemonId: string, label?: string): DaemonConnectionRecord => ({
  ...daemonConnection({ daemonId, baseUrl: `https://${daemonId}.example.test`, deviceToken: `${daemonId}-token` }),
  ...(label === undefined ? {} : { label }),
  pairedAt: 0,
  lastSelectedAt: 0,
});
const alpha = record('alpha', 'workstation');
const beta = record('beta');

/** A device id the real schema accepts, from a short readable key. */
const did = (key: string): string => `fy_device_id_${key.padEnd(22, '0')}`;

const device = (key: string, createdAt: string, name = key): PairedDevice => ({
  id: did(key),
  name,
  platform: 'browser',
  createdAt,
  lastSeenAt: createdAt,
});

const memory = (
  seed: Record<string, string> = {},
): DevicesLookedStorage & { readonly entries: Map<string, string> } => {
  const entries = new Map(Object.entries(seed));
  return {
    entries,
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
  };
};

interface Machine {
  view: PairedDevicesView;
  failRevoke?: boolean;
  readonly revoked: string[];
  readonly reads: { count: number };
}

/** A pool whose machines answer from a table, and record every removal. */
const pool = (machines: Record<string, Machine | 'unreachable'>): NewDeviceNoticeClients => ({
  client: async connection => {
    const machine = machines[String(connection.daemonId)];
    if (machine === undefined || machine === 'unreachable') throw new Error('unreachable');
    const client: PairingClient = {
      request: (async (path: string, _schema: unknown, init?: RequestInit) => {
        if (init?.method === 'DELETE') {
          const id = decodeURIComponent(path.split('/').at(-1) ?? '');
          if (machine.failRevoke) throw new Error('The machine refused.');
          machine.revoked.push(id);
          machine.view = { ...machine.view, devices: machine.view.devices.filter(entry => entry.id !== id) };
          return machine.view;
        }
        machine.reads.count += 1;
        return machine.view;
      }) as PairingClient['request'],
    };
    return client;
  },
});

const machine = (devices: PairedDevice[], thisDeviceId = did('me')): Machine => ({
  view: { devices, hostLocal: false, thisDeviceId },
  revoked: [],
  reads: { count: 0 },
});

const until = async (ready: () => boolean, what: string): Promise<void> => {
  await settleUntil(ready, what, runAsync);
};

const lookedAlpha = (at: number): Record<string, string> => ({ [devicesLookedKey(alpha.daemonId)]: String(at) });

describe('the new-device notice', () => {
  it('seeds the first look without announcing devices that were already there', async () => {
    const storage = memory();
    const alphaMachine = machine([device('old', ago(10 * MINUTE)), device('me', ago(MINUTE))]);
    const shown = await mount(
      <NewDeviceNotices connections={[alpha]} clients={pool({ alpha: alphaMachine })} storage={storage} now={now} />,
    );
    await until(() => storage.entries.size === 1, 'the first look to be remembered');
    expect(storage.entries.get(devicesLookedKey(alpha.daemonId))).toBe(String(NOW));
    expect(shown.container.querySelector('[data-new-device]')).toBeNull();
    await shown.unmount();
  });

  it('announces a device paired later in the same visit as the first look', async () => {
    const storage = memory();
    const alphaMachine = machine([device('old', ago(10 * MINUTE))]);
    const shown = await mount(
      <NewDeviceNotices
        connections={[alpha]}
        clients={pool({ alpha: alphaMachine })}
        storage={storage}
        now={now}
        refreshMs={5}
      />,
    );
    await until(() => storage.entries.size === 1, 'the first look to be remembered');
    alphaMachine.view = { ...alphaMachine.view, devices: [device('phone', new Date(NOW + MINUTE).toISOString())] };
    await until(() => shown.container.querySelector('[data-new-device]') !== null, 'the notice after a re-read');
    await shown.unmount();
  });

  it('names a device paired since this browser last looked, never this device itself', async () => {
    const alphaMachine = machine([
      device('old', ago(60 * MINUTE)),
      device('me', ago(MINUTE)),
      device('phone', ago(5 * MINUTE), 'Pixel 8'),
    ]);
    const shown = await mount(
      <NewDeviceNotices
        connections={[alpha]}
        clients={pool({ alpha: alphaMachine })}
        storage={memory(lookedAlpha(NOW - 30 * MINUTE))}
        now={now}
      />,
    );
    await until(() => shown.container.querySelector('[data-new-device]') !== null, 'the notice');
    const notices = [...shown.container.querySelectorAll('[data-new-device]')];
    expect(notices.map(notice => notice.getAttribute('data-new-device'))).toEqual([did('phone')]);
    expect(notices[0]?.textContent).toContain('A new device, Pixel 8, was paired with workstation 5 minutes ago.');
    await shown.unmount();
  });

  it('“That was me” on the last one marks this machine looked', async () => {
    const storage = memory(lookedAlpha(NOW - 30 * MINUTE));
    const alphaMachine = machine([device('phone', ago(5 * MINUTE))]);
    const shown = await mount(
      <NewDeviceNotices connections={[alpha]} clients={pool({ alpha: alphaMachine })} storage={storage} now={now} />,
    );
    await until(() => shown.container.querySelector('[data-new-device]') !== null, 'the notice');
    await interact(() =>
      must(shown.container.querySelector<HTMLButtonElement>('[data-new-device-mine]'), 'mine').click(),
    );
    expect(shown.container.querySelector('[data-new-device]')).toBeNull();
    expect(storage.entries.get(devicesLookedKey(alpha.daemonId))).toBe(String(NOW));
    await shown.unmount();
  });

  it('“That was me” with others still unanswered hides only that one', async () => {
    const storage = memory(lookedAlpha(NOW - 30 * MINUTE));
    const alphaMachine = machine([device('phone', ago(5 * MINUTE)), device('tablet', ago(2 * MINUTE))]);
    const shown = await mount(
      <NewDeviceNotices connections={[alpha]} clients={pool({ alpha: alphaMachine })} storage={storage} now={now} />,
    );
    await until(() => shown.container.querySelectorAll('[data-new-device]').length === 2, 'two notices');
    await interact(() =>
      must(
        shown.container.querySelector<HTMLButtonElement>(`[data-new-device="${did('tablet')}"] [data-new-device-mine]`),
        'mine',
      ).click(),
    );
    const left = [...shown.container.querySelectorAll('[data-new-device]')].map(n => n.getAttribute('data-new-device'));
    expect(left).toEqual([did('phone')]);
    expect(storage.entries.get(devicesLookedKey(alpha.daemonId))).toBe(String(NOW - 30 * MINUTE));
    await shown.unmount();
  });

  it('“Remove it” removes the device in one tap and confirms the result', async () => {
    const storage = memory(lookedAlpha(NOW - 30 * MINUTE));
    const alphaMachine = machine([device('me', ago(60 * MINUTE)), device('phone', ago(5 * MINUTE), 'Pixel 8')]);
    const shown = await mount(
      <NewDeviceNotices connections={[alpha]} clients={pool({ alpha: alphaMachine })} storage={storage} now={now} />,
    );
    await until(
      () => shown.container.querySelector<HTMLButtonElement>('[data-new-device-remove]')?.disabled === false,
      'the remove control',
    );
    await interact(() =>
      must(shown.container.querySelector<HTMLButtonElement>('[data-new-device-remove]'), 'remove').click(),
    );
    await until(() => shown.container.querySelector('[data-new-device-removed]') !== null, 'the confirmation');
    expect(alphaMachine.revoked).toEqual([did('phone')]);
    expect(shown.container.querySelector('[data-new-device]')).toBeNull();
    expect(shown.container.textContent).toContain('Pixel 8 was removed. It can no longer reach workstation.');
    expect(storage.entries.get(devicesLookedKey(alpha.daemonId))).toBe(String(NOW));
    await interact(() =>
      must(shown.container.querySelector<HTMLButtonElement>('[data-new-device-dismiss]'), 'dismiss').click(),
    );
    expect(shown.container.querySelector('[data-new-device-removed]')).toBeNull();
    await shown.unmount();
  });

  it('removing one of two keeps the other announced', async () => {
    const storage = memory(lookedAlpha(NOW - 30 * MINUTE));
    const alphaMachine = machine([device('phone', ago(5 * MINUTE)), device('tablet', ago(2 * MINUTE))]);
    const shown = await mount(
      <NewDeviceNotices connections={[alpha]} clients={pool({ alpha: alphaMachine })} storage={storage} now={now} />,
    );
    await until(
      () => shown.container.querySelector<HTMLButtonElement>('[data-new-device-remove]')?.disabled === false,
      'the remove control',
    );
    await interact(() =>
      must(
        shown.container.querySelector<HTMLButtonElement>(
          `[data-new-device="${did('tablet')}"] [data-new-device-remove]`,
        ),
        'remove',
      ).click(),
    );
    await until(() => shown.container.querySelector('[data-new-device-removed]') !== null, 'the confirmation');
    const left = [...shown.container.querySelectorAll('[data-new-device]')].map(n => n.getAttribute('data-new-device'));
    expect(left).toEqual([did('phone')]);
    expect(storage.entries.get(devicesLookedKey(alpha.daemonId))).toBe(String(NOW - 30 * MINUTE));
    await shown.unmount();
  });

  it('says when a removal failed and keeps the notice', async () => {
    const alphaMachine = { ...machine([device('phone', ago(5 * MINUTE), 'Pixel 8')]), failRevoke: true };
    const shown = await mount(
      <NewDeviceNotices
        connections={[alpha]}
        clients={pool({ alpha: alphaMachine })}
        storage={memory(lookedAlpha(NOW - 30 * MINUTE))}
        now={now}
      />,
    );
    await until(
      () => shown.container.querySelector<HTMLButtonElement>('[data-new-device-remove]')?.disabled === false,
      'the remove control',
    );
    await interact(() =>
      must(shown.container.querySelector<HTMLButtonElement>('[data-new-device-remove]'), 'remove').click(),
    );
    await until(() => shown.container.querySelector('[data-new-device-failure]') !== null, 'the failure');
    expect(shown.container.querySelector('[data-new-device-failure]')?.textContent).toBe(
      'Pixel 8 could not be removed: The machine refused.',
    );
    expect(shown.container.querySelector('[data-new-device]')).not.toBeNull();
    // Answering it clears the failure along with the notice.
    await interact(() =>
      must(shown.container.querySelector<HTMLButtonElement>('[data-new-device-mine]'), 'mine').click(),
    );
    expect(shown.container.querySelector('[data-new-device]')).toBeNull();
    await shown.unmount();
  });

  it('hides a machine’s notice when Security marks it looked, and leaves other machines alone', async () => {
    const storage = memory({
      ...lookedAlpha(NOW - 30 * MINUTE),
      [devicesLookedKey(beta.daemonId)]: String(NOW - 30 * MINUTE),
    });
    const shown = await mount(
      <NewDeviceNotices
        connections={[alpha, beta]}
        clients={pool({
          alpha: machine([device('phone', ago(5 * MINUTE))]),
          beta: machine([device('laptop', ago(5 * MINUTE))]),
        })}
        storage={storage}
        now={now}
      />,
    );
    await until(() => shown.container.querySelectorAll('[data-new-device]').length === 2, 'both notices');
    expect(shown.container.textContent).toContain('was paired with https://beta.example.test');
    await interact(() => markDevicesLooked(storage, alpha.daemonId, NOW));
    const left = [...shown.container.querySelectorAll('[data-new-device]')].map(n => n.getAttribute('data-new-device'));
    expect(left).toEqual([did('laptop')]);
    await shown.unmount();
  });

  it('works without storage, says nothing for an unreachable machine, and reads again on a timer', async () => {
    const alphaMachine = machine([]);
    // Counting READS is not enough on a loaded runner: the read is counted before its answer is applied,
    // and a device swapped in before the first look is seeded is, correctly, "already there".
    let seeded = false;
    const onLooked = (): void => {
      seeded = true;
    };
    window.addEventListener(DEVICES_LOOKED_EVENT, onLooked);
    const shown = await mount(
      <NewDeviceNotices
        connections={[alpha, beta]}
        clients={pool({ alpha: alphaMachine, beta: 'unreachable' })}
        storage={undefined}
        now={now}
        refreshMs={5}
      />,
    );
    await until(() => seeded, 'the first look to be seeded');
    window.removeEventListener(DEVICES_LOOKED_EVENT, onLooked);
    expect(shown.container.querySelector('[data-new-device]')).toBeNull();
    // A device paired after this page first looked is news even with no storage at all.
    alphaMachine.view = { ...alphaMachine.view, devices: [device('phone', new Date(NOW + MINUTE).toISOString())] };
    await until(() => shown.container.querySelector('[data-new-device]') !== null, 'the notice after a re-read');
    expect(NEW_DEVICE_REFRESH_MS).toBe(5 * 60_000);
    await shown.unmount();
  });

  it('drops an answer that arrives after it was closed, and renders nothing with no machines', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const alphaMachine = machine([device('phone', ago(MINUTE))]);
    const slow: NewDeviceNoticeClients = {
      client: async connection => {
        await gate;
        return await pool({ alpha: alphaMachine }).client(connection);
      },
    };
    const storage = memory();
    const shown = await mount(<NewDeviceNotices connections={[alpha]} clients={slow} storage={storage} now={now} />);
    await shown.render(<NewDeviceNotices connections={[]} clients={slow} storage={storage} now={now} />);
    expect(shown.container.querySelector('[data-new-device-notices]')).toBeNull();
    await runAsync(async () => {
      release();
      await gate;
    });
    await until(() => alphaMachine.reads.count === 1, 'the late read');
    expect(storage.entries.size).toBe(0);
    await shown.unmount();
  });

  it('reads nothing but the device list, and removes only through it', async () => {
    const requests: string[] = [];
    const alphaMachine = machine([device('phone', ago(5 * MINUTE))]);
    const inner = pool({ alpha: alphaMachine });
    const recording: NewDeviceNoticeClients = {
      client: async connection => {
        const client = await inner.client(connection);
        return {
          request: (async (path: string, schema: unknown, init?: RequestInit) => {
            requests.push(`${init?.method ?? 'GET'} ${path}`);
            return await client.request(path, schema as never, init);
          }) as PairingClient['request'],
        };
      },
    };
    const shown = await mount(
      <NewDeviceNotices
        connections={[alpha]}
        clients={recording}
        storage={memory(lookedAlpha(NOW - 30 * MINUTE))}
        now={now}
      />,
    );
    await until(
      () => shown.container.querySelector<HTMLButtonElement>('[data-new-device-remove]')?.disabled === false,
      'the remove control',
    );
    await interact(() =>
      must(shown.container.querySelector<HTMLButtonElement>('[data-new-device-remove]'), 'remove').click(),
    );
    await until(() => shown.container.querySelector('[data-new-device-removed]') !== null, 'the confirmation');
    expect(requests).toEqual(['GET /v1/pair/devices', `DELETE /v1/pair/devices/${did('phone')}`]);
    await shown.unmount();
  });

  it('uses the browser store and clock by default', async () => {
    const shown = await mount(<NewDeviceNotices connections={[alpha]} clients={pool({ alpha: 'unreachable' })} />);
    expect(shown.container.querySelector('[data-new-device-notices]')).not.toBeNull();
    await shown.unmount();
  });
});
