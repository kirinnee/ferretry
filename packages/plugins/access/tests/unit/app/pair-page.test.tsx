import { afterEach, describe, expect, it } from 'bun:test';
import {
  type DaemonlessPorts,
  type DaemonlessScreenProps,
  type PairDirectInput,
  type PairedDaemon,
  type PairedOver,
  RelayPairingRefusedError,
} from '@ferretry/app';
import { pairPage } from '../../../app/pair-page.tsx';
import { MemoryDeviceKeyStore, testDeviceKeyCrypto } from '../../support/app/device-keys.ts';
import { interact, type Mounted, mount, must } from '../../support/app/dom.ts';

/**
 * ACCESS'S DAEMON-LESS `/pair` PAGE (D2 #26): the QR link a machine shows lands here on a device with no daemon yet,
 * and the exchange rides the `pair` carriers the shell hands it. The code is a FIXED FAKE; a real one is never used.
 */

const FAKE_CODE = '7F3K-Q2ND';
const DAEMON = `fy_daemon_${'d'.repeat(43)}`;
const DEVICE = `fy_device_id_${'b'.repeat(22)}`;
const LINK = `https://pwa.example.test/pair#v1;url=${encodeURIComponent('https://daemon.example.test')};code=${FAKE_CODE};fp=${DAEMON}`;

const answer = {
  deviceId: DEVICE,
  idleExpiryDays: 30,
  daemonId: DAEMON,
  daemonName: 'workstation',
  capabilities: ['daemon-api'],
  carriers: [{ kind: 'direct', url: 'https://daemon.example.test' }],
};

/** A paired list that behaves like the shell's (`add` selects, `remove` forgets). */
function fakeDaemons(initial: readonly PairedDaemon[] = []) {
  let snapshot = { daemons: initial, selected: initial[0]?.daemon ?? (null as string | null) };
  const listeners = new Set<() => void>();
  const set = (next: typeof snapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    add: (input: Record<string, unknown>) => {
      const added = { ...input, pairedAt: 1, lastSelectedAt: 1 } as unknown as PairedDaemon;
      set({ daemons: [added], selected: added.daemon });
      return added;
    },
    select: (daemon: string) => set({ ...snapshot, selected: daemon }),
    remove: (daemon: string) =>
      set({ daemons: snapshot.daemons.filter(entry => entry.daemon !== daemon), selected: null }),
  };
}

function setup(carrier: (input: PairDirectInput) => Promise<PairedOver>, initial: readonly PairedDaemon[] = []) {
  const store = new MemoryDeviceKeyStore();
  const daemons = fakeDaemons(initial);
  const ports = {
    crypto: testDeviceKeyCrypto as never,
    indexedDB: null,
    daemons: daemons as never,
    pairDirect: async () => {
      throw new Error('pairing is never direct-only here: the walk is the shell’s `pair`');
    },
    pair: carrier,
  } as unknown as DaemonlessPorts;
  const Page = pairPage(ports, { store, scanHost: () => null, defaultName: () => 'My phone' });
  return { Page, store, daemons };
}

interface Navigation {
  readonly to: string;
  readonly replace: boolean | undefined;
}

function props(href: string, moves: Navigation[]): DaemonlessScreenProps {
  return {
    params: {},
    location: () => href,
    navigate: (to, options) => {
      moves.push({ to, replace: options?.replace });
    },
  };
}

const paired = (): PairDirectInput[] => [];

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const button = (text: string): HTMLButtonElement =>
  must([...(view?.container.querySelectorAll('button') ?? [])].find(b => b.textContent?.includes(text)) ?? null, text);

/** Everything the code could leak through, watched while `run` happens. */
async function watching(run: () => Promise<void>): Promise<{ readonly leaks: string[] }> {
  const leaks: string[] = [];
  const consoleKeys = ['log', 'debug', 'info', 'warn', 'error', 'trace'] as const;
  const originals = consoleKeys.map(key => console[key]);
  for (const key of consoleKeys) {
    console[key] = (...args: unknown[]) => {
      if (JSON.stringify(args).includes(FAKE_CODE)) leaks.push(`console.${key}`);
    };
  }
  const storages = [window.localStorage, window.sessionStorage];
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key: string, value: string) {
    if (`${key}${value}`.includes(FAKE_CODE)) leaks.push('storage');
    return setItem.call(this, key, value);
  };
  try {
    await run();
  } finally {
    consoleKeys.forEach((key, index) => {
      console[key] = originals[index] as never;
    });
    Storage.prototype.setItem = setItem;
    void storages;
  }
  return { leaks };
}

describe('the /pair page', () => {
  it('lands on a link, takes the code out of the address, and pairs over the shell’s walk', async () => {
    const inputs = paired();
    const { Page, store } = setup(async input => {
      inputs.push(input);
      await input.key.save(answer as never);
      return {
        kind: 'paired',
        response: answer,
        via: { kind: 'direct', address: 'https://daemon.example.test' },
      } as PairedOver;
    });
    const moves: Navigation[] = [];
    const { leaks } = await watching(async () => {
      view = await mount(<Page {...props(LINK, moves)} />);
      // The arrival is a confirmation, not a form; the code is not on the screen.
      expect(view.container.textContent).toContain('daemon.example.test');
      expect(view.container.textContent).not.toContain(FAKE_CODE);
      // The address loses the fragment at once: replace the entry with its bare path, never push.
      expect(moves[0]).toEqual({ to: '/pair', replace: true });
      await interact(() => button('Pair this device').click());
      await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ address: 'https://daemon.example.test', daemonId: DAEMON, code: FAKE_CODE });
    expect(inputs[0]?.key.deviceName).toBe('My phone');
    expect(store.keys.has(DAEMON)).toBe(true);
    expect(moves.at(-1)).toEqual({ to: `/d/${DAEMON}`, replace: undefined });
    // R-pairing rules: the code reached no console, no storage, no live region, no address.
    expect(leaks).toEqual([]);
    expect(moves.some(move => move.to.includes(FAKE_CODE))).toBe(false);
    for (const region of must(view, 'the page').container.querySelectorAll(
      '[aria-live], [role="status"], [role="alert"]',
    )) {
      expect(region.textContent).not.toContain(FAKE_CODE);
    }
    expect(must(view, 'the page').container.innerHTML).not.toContain(FAKE_CODE);
  });

  it('after a sealed refusal says one sentence without the code, keeps no key, and never retries on its own', async () => {
    let attempts = 0;
    const { Page, store } = setup(async () => {
      attempts += 1;
      throw new RelayPairingRefusedError();
    });
    const moves: Navigation[] = [];
    const { leaks } = await watching(async () => {
      view = await mount(<Page {...props(LINK, moves)} />);
      await interact(() => button('Pair this device').click());
      await interact(() => new Promise(resolve => setTimeout(resolve, 20)));
    });
    expect(attempts).toBe(1);
    expect(store.keys.size).toBe(0);
    expect(must(view, 'the page').container.textContent).not.toContain(FAKE_CODE);
    expect(leaks).toEqual([]);
    // Nothing navigated to a machine: the refusal ends the attempt.
    expect(moves.every(move => !move.to.startsWith('/d/'))).toBe(true);
  });

  it('a cold open offers the paste path and holds no code', async () => {
    const { Page } = setup(async () => {
      throw new Error('not used');
    });
    const moves: Navigation[] = [];
    view = await mount(<Page {...props('https://pwa.example.test/pair', moves)} />);
    expect(view.container.textContent).toContain('Connect a daemon');
    expect(moves).toEqual([]);
  });

  it('says a machine no longer accepts this browser when the shell sends it here for that', async () => {
    const machine = {
      daemon: DAEMON,
      machine: 'workstation',
      deviceId: DEVICE,
      address: 'https://daemon.example.test',
      carriers: [],
      pairedAt: 1,
      lastSelectedAt: 1,
    } as PairedDaemon;
    const { Page } = setup(async () => {
      throw new Error('not used');
    }, [machine]);
    view = await mount(<Page {...props(`https://pwa.example.test/pair?refused=${DAEMON}`, [])} />);
    expect(view.container.querySelector('[data-device-refused]')?.textContent).toContain('workstation');
    expect(view.container.textContent).toContain('no longer accepts this browser');
    await interact(() =>
      must(view?.container.querySelector<HTMLElement>('[data-device-refused-pair]') ?? null, 'pair again').click(),
    );
    expect(view.container.querySelector('[data-device-refused]')).toBeNull();
  });
});
