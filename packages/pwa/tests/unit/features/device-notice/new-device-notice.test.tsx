import '../../../support/dom.ts';
import { describe, expect, it } from 'bun:test';
import { auditShortId, FULL_DEVICE_GRANTS, type PairedDevice, type PairedDevicesView } from '@ferretry/protocol';
import {
  announceDevicesLooked,
  type DevicesLookedStorage,
  devicesLookedKey,
} from '../../../../src/features/device-notice/devices-looked.ts';
import {
  NEW_DEVICE_REFRESH_MS,
  type NewDeviceNoticeClients,
  NewDeviceNotices,
  type NewDeviceSchedule,
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
  ...daemonConnection({
    daemonId,
    baseUrl: `https://${daemonId}.example.test`,
    deviceId: `fy_device_id_${daemonId.padEnd(22, '0')}`,
  }),
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
  idleExpiresAt: createdAt,
  grants: FULL_DEVICE_GRANTS,
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
  view: { devices, hostLocal: false, thisDeviceId, mayWiden: FULL_DEVICE_GRANTS },
  revoked: [],
  reads: { count: 0 },
});

const until = async (ready: () => boolean, what: string): Promise<void> => {
  await settleUntil(ready, what, runAsync);
};

/** A schedule the test fires by hand: no real timer, so a loaded runner cannot outrun it. */
const manualSchedule = () => {
  const reads = new Set<() => void>();
  const schedule: NewDeviceSchedule = read => {
    reads.add(read);
    return () => reads.delete(read);
  };
  return {
    schedule,
    fire: () => {
      for (const read of reads) read();
    },
    armed: () => reads.size,
  };
};

const DAY = 24 * 60 * MINUTE;
/** Storage that has already seen these devices on alpha. */
const seenAlpha = (...keys: string[]): Record<string, string> => ({
  [devicesLookedKey(alpha.daemonId)]: JSON.stringify(keys.map(did).toSorted()),
});
const storedAlpha = (storage: { readonly entries: Map<string, string> }): unknown =>
  JSON.parse(storage.entries.get(devicesLookedKey(alpha.daemonId)) ?? 'null');
const label = (key: string, name = key): string => `“${name}” (${auditShortId(did(key))})`;

describe('the new-device notice', () => {
  it('seeds the first look without announcing devices that were already there', async () => {
    const storage = memory();
    const alphaMachine = machine([device('old', ago(3 * DAY)), device('me', ago(MINUTE))]);
    const shown = await mount(
      <NewDeviceNotices connections={[alpha]} clients={pool({ alpha: alphaMachine })} storage={storage} now={now} />,
    );
    await until(() => storage.entries.size === 1, 'the first look to be remembered');
    expect(storedAlpha(storage)).toEqual([did('old')]);
    expect(shown.container.querySelector('[data-new-device]')).toBeNull();
    await shown.unmount();
  });

  it('on a first look, still announces a device paired within a day of the newest, whatever this clock says', async () => {
    // This browser's clock is a year ahead, and nothing is stored. The daemon's own createdAt values
    // are all that decide: the stranger paired an hour before this browser is news; the old one is not.
    const skewed = () => NOW + 365 * DAY;
    const storage = memory();
    const alphaMachine = machine([
      device('old', ago(3 * DAY)),
      device('stranger', ago(60 * MINUTE), 'iPad'),
      device('me', ago(MINUTE)),
    ]);
    const shown = await mount(
      <NewDeviceNotices connections={[alpha]} clients={pool({ alpha: alphaMachine })} storage={storage} now={skewed} />,
    );
    await until(() => shown.container.querySelector('[data-new-device]') !== null, 'the first-look notice');
    const notices = [...shown.container.querySelectorAll('[data-new-device]')];
    expect(notices.map(notice => notice.getAttribute('data-new-device'))).toEqual([did('stranger')]);
    expect(storedAlpha(storage)).toEqual([did('old')]);
    await shown.unmount();
  });

  it('ignores a look announced before the list was ever read', async () => {
    const storage = memory(seenAlpha());
    const shown = await mount(
      <NewDeviceNotices connections={[alpha]} clients={pool({ alpha: 'unreachable' })} storage={storage} now={now} />,
    );
    await interact(() => announceDevicesLooked(alpha.daemonId, [did('phone')]));
    expect(storedAlpha(storage)).toEqual([]);
    await shown.unmount();
  });

  it('announces a device paired later in the same visit as the first look', async () => {
    const timer = manualSchedule();
    const storage = memory();
    const alphaMachine = machine([device('old', ago(10 * MINUTE))]);
    const shown = await mount(
      <NewDeviceNotices
        connections={[alpha]}
        clients={pool({ alpha: alphaMachine })}
        storage={storage}
        now={now}
        schedule={timer.schedule}
      />,
    );
    await until(() => storage.entries.size === 1, 'the first look to be remembered');
    // Its createdAt is a week in the past: a re-read finds a new ID, and no clock is consulted.
    alphaMachine.view = { ...alphaMachine.view, devices: [device('phone', ago(7 * DAY))] };
    timer.fire();
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
        storage={memory(seenAlpha('old'))}
        now={now}
      />,
    );
    await until(() => shown.container.querySelector('[data-new-device]') !== null, 'the notice');
    const notices = [...shown.container.querySelectorAll('[data-new-device]')];
    expect(notices.map(notice => notice.getAttribute('data-new-device'))).toEqual([did('phone')]);
    expect(notices[0]?.textContent).toContain(
      `A device calling itself ${label('phone', 'Pixel 8')} was paired with workstation 5 minutes ago (`,
    );
    await shown.unmount();
  });

  it('“That was me” on the last one marks this machine looked', async () => {
    const storage = memory(seenAlpha());
    const alphaMachine = machine([device('phone', ago(5 * MINUTE))]);
    const shown = await mount(
      <NewDeviceNotices connections={[alpha]} clients={pool({ alpha: alphaMachine })} storage={storage} now={now} />,
    );
    await until(() => shown.container.querySelector('[data-new-device]') !== null, 'the notice');
    await interact(() =>
      must(shown.container.querySelector<HTMLButtonElement>('[data-new-device-mine]'), 'mine').click(),
    );
    expect(shown.container.querySelector('[data-new-device]')).toBeNull();
    expect(storedAlpha(storage)).toEqual([did('phone')]);
    await shown.unmount();
  });

  it('“That was me” with others still unanswered hides only that one', async () => {
    const storage = memory(seenAlpha());
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
    expect(storedAlpha(storage)).toEqual([did('tablet')]);
    await shown.unmount();
  });

  it('“Remove it” removes the device in one tap and confirms the result', async () => {
    const storage = memory(seenAlpha('gone'));
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
    expect(shown.container.textContent).toContain(
      `${label('phone', 'Pixel 8')} was removed. It can no longer reach workstation.`,
    );
    // Ids the list no longer has are dropped, so the stored set stays bounded by the devices that exist.
    expect(storedAlpha(storage)).toEqual([]);
    await interact(() =>
      must(shown.container.querySelector<HTMLButtonElement>('[data-new-device-dismiss]'), 'dismiss').click(),
    );
    expect(shown.container.querySelector('[data-new-device-removed]')).toBeNull();
    await shown.unmount();
  });

  it('removing one of two keeps the other announced', async () => {
    const storage = memory(seenAlpha());
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
    expect(storedAlpha(storage)).toEqual([]);
    await shown.unmount();
  });

  it('says when a removal failed and keeps the notice', async () => {
    const alphaMachine = { ...machine([device('phone', ago(5 * MINUTE), 'Pixel 8')]), failRevoke: true };
    const shown = await mount(
      <NewDeviceNotices
        connections={[alpha]}
        clients={pool({ alpha: alphaMachine })}
        storage={memory(seenAlpha())}
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
      `${label('phone', 'Pixel 8')} could not be removed: The machine refused.`,
    );
    expect(shown.container.querySelector('[data-new-device]')).not.toBeNull();
    // Answering it clears the failure along with the notice.
    await interact(() =>
      must(shown.container.querySelector<HTMLButtonElement>('[data-new-device-mine]'), 'mine').click(),
    );
    expect(shown.container.querySelector('[data-new-device]')).toBeNull();
    await shown.unmount();
  });

  it('hides only the devices Security actually showed, and leaves other machines alone', async () => {
    const storage = memory({ ...seenAlpha(), [devicesLookedKey(beta.daemonId)]: '[]' });
    const shown = await mount(
      <NewDeviceNotices
        connections={[alpha, beta]}
        clients={pool({
          alpha: machine([device('phone', ago(5 * MINUTE)), device('stranger', ago(6 * MINUTE))]),
          beta: machine([device('laptop', ago(5 * MINUTE))]),
        })}
        storage={storage}
        now={now}
      />,
    );
    await until(() => shown.container.querySelectorAll('[data-new-device]').length === 3, 'every notice');
    expect(shown.container.textContent).toContain('was paired with https://beta.example.test');
    // A look that showed nothing marks nothing; one that showed the phone's pairing — and an id the
    // notice never read — marks the phone alone. The stranger, whose pairing was not shown, stays news.
    await interact(() => announceDevicesLooked(alpha.daemonId, []));
    expect(shown.container.querySelectorAll('[data-new-device]')).toHaveLength(3);
    await interact(() => announceDevicesLooked(alpha.daemonId, [did('phone'), did('never-listed')]));
    const left = [...shown.container.querySelectorAll('[data-new-device]')].map(n => n.getAttribute('data-new-device'));
    expect(left).toEqual([did('stranger'), did('laptop')]);
    expect(storedAlpha(storage)).toEqual([did('phone')]);
    await shown.unmount();
  });

  it('works without storage, says nothing for an unreachable machine, and reads again on a timer', async () => {
    const alphaMachine = machine([]);
    const timer = manualSchedule();
    // Storage that refuses every read and write: the instant lives only in the notice itself. The
    // refused write is also the signal that the first answer was applied — never a page-wide event,
    // which an earlier file in the same process may have left a replaced `window` behind for.
    let seedAttempts = 0;
    const refusing: DevicesLookedStorage = {
      getItem: () => {
        throw new Error('storage is off');
      },
      setItem: () => {
        seedAttempts += 1;
        throw new Error('storage is off');
      },
    };
    const shown = await mount(
      <NewDeviceNotices
        connections={[alpha, beta]}
        clients={pool({ alpha: alphaMachine, beta: 'unreachable' })}
        storage={refusing}
        now={now}
        schedule={timer.schedule}
      />,
    );
    await until(() => seedAttempts === 1, 'the first look to be seeded');
    expect(shown.container.querySelector('[data-new-device]')).toBeNull();
    // A device paired after this page first looked is news even with no storage at all.
    alphaMachine.view = { ...alphaMachine.view, devices: [device('phone', new Date(NOW + MINUTE).toISOString())] };
    timer.fire();
    await until(() => shown.container.querySelector('[data-new-device]') !== null, 'the notice after a re-read');
    await shown.unmount();
    expect(timer.armed()).toBe(0);
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
      <NewDeviceNotices connections={[alpha]} clients={recording} storage={memory(seenAlpha())} now={now} />,
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

describe('the default refresh schedule', () => {
  it('reads again every five minutes and stops when the notice goes away', async () => {
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const armed: Array<{ readonly ms: number | undefined; readonly id: number }> = [];
    const cleared: unknown[] = [];
    globalThis.setInterval = ((_read: () => void, ms?: number) => {
      const id = armed.length + 1;
      armed.push({ ms, id });
      return id;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = ((id: unknown) => void cleared.push(id)) as typeof clearInterval;
    try {
      const shown = await mount(
        <NewDeviceNotices connections={[alpha]} clients={pool({ alpha: machine([]) })} storage={undefined} now={now} />,
      );
      await shown.unmount();
      expect(armed.map(entry => entry.ms)).toEqual([NEW_DEVICE_REFRESH_MS]);
      expect(cleared).toEqual([1]);
      expect(NEW_DEVICE_REFRESH_MS).toBe(5 * 60_000);
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
  });
});

describe('the new-device notice on a phone', () => {
  /** Layout reads `innerWidth`; every phone case sets it and puts it back. */
  const onPhone = async (body: () => Promise<void>): Promise<void> => {
    const original = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });
    try {
      await body();
    } finally {
      if (original) Object.defineProperty(window, 'innerWidth', original);
      else Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'innerWidth');
    }
  };
  const phoneNotice = async (alphaMachine: Machine) => {
    const shown = await mount(
      <NewDeviceNotices
        connections={[alpha]}
        clients={pool({ alpha: alphaMachine })}
        storage={memory(seenAlpha('old', 'me'))}
        now={now}
      />,
    );
    await until(() => shown.container.querySelector('[data-new-device-compact]') !== null, 'the one-line notice');
    return shown;
  };
  const review = (): HTMLButtonElement =>
    must(document.querySelector('[data-new-device-review]'), 'the Review button') as HTMLButtonElement;
  const sheet = (): HTMLElement =>
    must(document.getElementById(review().getAttribute('aria-controls') ?? ''), 'the review sheet') as HTMLElement;

  it('is one row naming the device, with the sentence and its actions one tap away in a sheet', async () => {
    await onPhone(async () => {
      const alphaMachine = machine([device('me', ago(MINUTE)), device('phone', ago(5 * MINUTE), 'Pixel 8')]);
      const shown = await phoneNotice(alphaMachine);
      const row = must(
        shown.container.querySelector('[data-new-device-compact]'),
        'the one-line notice',
      ) as HTMLElement;
      expect(row.textContent).toBe('New device paired: “Pixel 8”Review');
      expect(row.getAttribute('role')).toBe('status');
      expect(row.hasAttribute('data-kb-hide')).toBe(true);
      // The actions live only in the sheet, which is closed.
      expect(row.querySelector('[data-new-device-mine], [data-new-device-remove]')).toBeNull();
      expect(document.getElementById(review().getAttribute('aria-controls') ?? '')).toBeNull();

      await interact(() => review().click());
      expect(sheet().getAttribute('aria-modal')).toBe('true');
      expect(sheet().textContent).toContain(`A device calling itself ${label('phone', 'Pixel 8')} was paired with`);

      await interact(() =>
        (
          must(sheet().querySelector('[data-new-device-remove]'), 'Remove it in the sheet') as HTMLButtonElement
        ).click(),
      );
      await until(() => alphaMachine.revoked.length === 1, 'the removal');
      expect(alphaMachine.revoked).toEqual([did('phone')]);
      await until(() => shown.container.querySelector('[data-new-device-removed]') !== null, 'the removed row');
      expect(shown.container.querySelector('[data-new-device-compact]')).toBeNull();
      await shown.unmount();
    });
  });

  it('closes its sheet when the keyboard comes up', async () => {
    await onPhone(async () => {
      const shown = await phoneNotice(machine([device('me', ago(MINUTE)), device('phone', ago(5 * MINUTE))]));
      await interact(() => review().click());
      expect(sheet().getAttribute('aria-modal')).toBe('true');
      try {
        await interact(() => document.documentElement.setAttribute('data-keyboard', 'open'));
        expect(sheet().getAttribute('aria-modal')).toBeNull();
      } finally {
        document.documentElement.removeAttribute('data-keyboard');
      }
      // Dismissed through the sheet's own path as well.
      await interact(() => review().click());
      await interact(() =>
        (
          must(
            document.querySelector('[aria-label="Dismiss the new device notice"]'),
            'the sheet backdrop',
          ) as HTMLButtonElement
        ).click(),
      );
      expect(sheet().getAttribute('aria-modal')).toBeNull();
      await shown.unmount();
    });
  });
});
