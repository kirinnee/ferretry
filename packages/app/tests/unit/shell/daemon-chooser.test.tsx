import { afterEach, describe, expect, test } from 'bun:test';
import { lazy, type ReactNode, useState } from 'react';
import { BottomSheet } from '../../../src/ui/bottom-sheet.tsx';
import { implementApp, type Manifest } from '@ferretry/kernel/manifest';
import {
  type ChosenDaemon,
  type DaemonlessScreenProps,
  type PasskeyHostPorts,
  provideToShell,
  registeredDaemonless,
  registeredPasskey,
} from '../../../src/connect/provides.ts';
import type { TransportRequest } from '../../../src/client/transport.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import type { PasskeyHandler, PasskeyNeed, PasskeyProvision } from '../../../src/passkey/passkey.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { App } from '../../../src/shell/app.tsx';
import type { ShellWindow } from '../../../src/shell/context.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { interact, mount } from '../../support/dom.ts';
import { CORE, FakeTransport, inventoryOf, json } from '../client/fixtures.ts';

/**
 * S10: a lazy half's first draw suspends only its own box, and a daemon-less screen may ASK for a machine. The person's
 * click is the only way to a client; the chosen machine counts as the machine on screen until the screen goes; and
 * nothing but `PasskeyMount` ever calls `focus`.
 */

const askManifest = {
  id: 'asker',
  title: 'Asker',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view'],
  actions: { routes: [{ key: 'GET /v1/asker/preview', minimum: 'authenticated', caller: 'any', audit: 'skip' }] },
  ui: {
    screens: [
      { id: 'ask', path: '/ask', daemonless: true },
      { id: 'other', path: '/other', daemonless: true },
      { id: 'sheet', path: '/sheet', daemonless: true },
      { id: 'slow', path: '/slow', daemonless: true },
    ],
  },
} as unknown as Manifest;
const accessManifest = {
  id: 'access',
  title: 'Access',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view'],
} as unknown as Manifest;

const answers: { chosen: (ChosenDaemon | undefined)[]; previews: unknown[]; question?: Promise<unknown> } = {
  chosen: [],
  previews: [],
};
let chooseFn: DaemonlessScreenProps['chooseDaemon'] | undefined;

function Ask({ chooseDaemon }: DaemonlessScreenProps): ReactNode {
  chooseFn = chooseDaemon;
  return (
    <button
      type="button"
      data-testid="ask"
      onClick={() => {
        void chooseDaemon('Install on which machine?').then(chosen => {
          answers.chosen.push(chosen);
          if (chosen !== undefined)
            void chosen.client.call('GET /v1/asker/preview').then(
              r => answers.previews.push(r),
              (refused: unknown) => answers.previews.push({ refused: (refused as { code?: string }).code }),
            );
        });
      }}
    >
      Install
    </button>
  );
}

/** A plugin screen like `/shared`: Install is pressed INSIDE the plugin's own open BottomSheet (a `fixed` z-40 overlay). */
function SheetAsk({ chooseDaemon }: DaemonlessScreenProps): ReactNode {
  const [open, setOpen] = useState(true);
  return (
    <div data-testid="sheet-screen">
      <BottomSheet id="plugin-sheet" open={open} onClose={() => setOpen(false)} closeLabel="Close the item">
        <button
          type="button"
          data-testid="sheet-install"
          onClick={() => {
            void chooseDaemon('Install on which machine?').then(chosen => {
              answers.chosen.push(chosen);
              if (chosen !== undefined)
                void chosen.client.call('GET /v1/asker/preview').then(
                  r => answers.previews.push(r),
                  (refused: unknown) => answers.previews.push({ refused: (refused as { code?: string }).code }),
                );
            });
          }}
        >
          Install on a machine
        </button>
      </BottomSheet>
    </div>
  );
}

// A half whose chunk arrives later: the first draw suspends.
let releaseChunk: (() => void) | undefined;
const Slow = lazy(
  () =>
    new Promise<{ default: (props: DaemonlessScreenProps) => ReactNode }>(resolve => {
      releaseChunk = () => resolve({ default: () => <p data-testid="slow-ready">Slow is ready</p> });
    }),
);

const askerApp = provideToShell(implementApp(askManifest, { build: () => ({}) }), {
  daemonless: () => ({
    ask: Ask as never,
    other: (() => <p data-testid="other">Other</p>) as never,
    sheet: SheetAsk as never,
    slow: (props: DaemonlessScreenProps) => <Slow {...props} />,
  }),
});

const entry = (manifest: Manifest, app: SurfaceEntry['app']): SurfaceEntry => ({
  id: manifest.id,
  title: manifest.title,
  core: false,
  contract: `h-${manifest.id}`,
  consumes: [],
  manifest,
  ...(app === undefined ? {} : { app }),
});

/** A passkey provision that records `focus` and holds an ordinary request for a machine until that machine is on screen. */
function provision() {
  const focused: (string | null)[] = [];
  const asked: PasskeyNeed[] = [];
  const waiters = new Set<() => void>();
  let onScreen: string | null = null;
  const handler: PasskeyHandler = {
    need: refusal =>
      refusal.status === 403 && (refusal.body as { code?: string }).code === 'grant_step_up_required'
        ? { kind: 'step-up' }
        : undefined,
    confirm: async (daemon, need, origin) => {
      while (origin !== 'explicit' && onScreen !== daemon.daemon)
        await new Promise<void>(resolve => waiters.add(resolve));
      asked.push(need);
      return true;
    },
    ask: async () => true,
    focus: daemon => {
      focused.push(daemon);
      onScreen = daemon;
      for (const wake of [...waiters]) wake();
      waiters.clear();
    },
    locked: () => [],
    subscribe: () => () => {},
  };
  const made: PasskeyProvision = { handler, Prompts: () => <div data-testid="access-prompts" /> };
  return { made, focused, asked };
}

const browser: ShellWindow = {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  document: { documentElement: document.documentElement },
};
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};

/** d1 runs Asker; d2 (the locked one) runs it too; d3 has Asker turned off. */
function setup(
  made: PasskeyProvision,
  down: readonly string[] = [],
  slow: readonly string[] = [],
  bad: { readonly unreadable?: readonly string[]; readonly refused?: readonly string[] } = {},
) {
  const accessApp = provideToShell(implementApp(accessManifest, { build: () => ({}) }), { passkey: () => made });
  const surfaces: SurfaceEntry[] = [...CORE, entry(askManifest, askerApp), entry(accessManifest, accessApp)];
  const transports = new Map<string, FakeTransport>();
  const transportOf = (daemon: string): FakeTransport => {
    const known = transports.get(daemon);
    if (known !== undefined) return known;
    let previews = 0;
    const made = new FakeTransport((request: TransportRequest) => {
      // A machine whose plugin list cannot be read (connected, inventory unreadable), or that refused this device (4403).
      if (request.path === '/v1/plugins' && bad.refused?.includes(daemon) === true)
        throw Object.assign(new Error('device refused'), { name: 'RelaySessionError', code: 4403 });
      if (request.path === '/v1/plugins' && bad.unreadable?.includes(daemon) === true)
        return json({ error: 'broken', code: 'internal' }, 500);
      if (request.path === '/v1/plugins')
        return json(inventoryOf(surfaces, daemon === 'd3' ? { asker: { on: false } } : {}));
      if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
      if (request.path === '/v1/asker/preview') {
        previews += 1;
        // The locked machine refuses the first read until the passkey is confirmed.
        return daemon === 'd2' && previews === 1
          ? json({ error: 'Confirm with a passkey.', code: 'grant_step_up_required' }, 403)
          : json({ ok: daemon });
      }
      return json({ error: 'none', code: 'not_found' }, 404);
    });
    transports.set(daemon, made);
    return made;
  };
  const storage = memoryStore();
  const daemons = new DaemonList({ storage, now: () => 1 });
  daemons.add({ daemon: 'd1', machine: 'laptop', deviceId: 'dev', address: 'http://127.0.0.1:40245' });
  daemons.add({ daemon: 'd2', machine: 'desk', deviceId: 'dev', address: 'http://127.0.0.1:40246' });
  daemons.add({ daemon: 'd3', machine: 'attic', deviceId: 'dev', address: 'http://127.0.0.1:40247' });
  const ports: PasskeyHostPorts = {
    clientOf: () => undefined,
    daemons,
    origin: 'https://app.example',
    credentials: { create: async () => null, get: async () => null },
  };
  const registered = registeredPasskey(surfaces, ports);
  const views = registeredDaemonless(surfaces, {} as never);
  const runtime = new ShellRuntime({
    appVersion: '5.0.0',
    surfaces,
    daemons,
    connect: async paired => {
      if (down.includes(paired.daemon)) throw new Error('unreachable');
      // Never answers: the machine stays "connecting".
      if (slow.includes(paired.daemon)) await new Promise<never>(() => undefined);
      return transportOf(paired.daemon);
    },
    passkey: () => registered.passkey,
    daemonless: { views: views.views, location: () => '' },
  });
  const app = (
    <App
      runtime={runtime}
      themes={new ThemePreferenceStore(storage)}
      layouts={new DeviceLayoutStore(storage)}
      browser={browser}
      scroll={new ScrollMemory(null)}
    />
  );
  return { runtime, daemons, app, transportOf };
}

const go = (path: string): void => window.history.replaceState({}, '', path);
afterEach(() => {
  go('/');
  answers.chosen = [];
  answers.previews = [];
  chooseFn = undefined;
});

const click = async (view: { container: HTMLElement }, selector: string): Promise<void> => {
  await interact(() => {
    (view.container.querySelector(selector) as HTMLElement | null)?.click();
  });
  await settle();
};

describe('S10 a lazy half suspends inside its own box', () => {
  test('S10 a suspended half does not blank the frame', async () => {
    go('/slow');
    const { app } = setup(provision().made);
    const view = await mount(app);
    await settle();
    expect(view.container.textContent).toContain('Loading Asker…');
    // The frame around it is still drawn.
    expect(view.container.querySelector('.fy-frame')).not.toBeNull();
    expect(view.container.querySelector('nav')).not.toBeNull();
    releaseChunk?.();
    await settle();
    expect(view.container.querySelector('[data-testid="slow-ready"]')).not.toBeNull();
    expect(view.container.textContent).not.toContain('Loading Asker…');
    await view.unmount();
  });
});

describe('S10 a daemon-less screen may ask for a machine', () => {
  test('S10 the picker lists only machines where the plugin is on, and never resolves without a click', async () => {
    go('/ask');
    const { app } = setup(provision().made);
    const view = await mount(app);
    await settle();
    await click(view, '[data-testid="ask"]');
    const listed = [...view.container.querySelectorAll('[data-chooser-machine]')].map(node =>
      node.getAttribute('data-chooser-machine'),
    );
    expect(listed.toSorted()).toEqual(['d1', 'd2']);
    expect(view.container.querySelector('[data-chooser] h2')?.textContent).toBe('Install on which machine?');
    await settle();
    expect(answers.chosen).toEqual([]);
    await view.unmount();
  });

  test('S10 M1 the picker is a real overlay: outside the screen’s subtree and on top of an open BottomSheet', async () => {
    go('/sheet');
    const { app, transportOf } = setup(provision().made);
    const view = await mount(app);
    await settle();
    const pluginSheet = view.container.querySelector('[data-bottom-sheet="plugin-sheet"]') as HTMLElement;
    expect(pluginSheet.className).toContain('z-40');
    expect(pluginSheet.querySelector('[aria-modal="true"]')).not.toBeNull();
    await click(view, '[data-testid="sheet-install"]');

    const picker = view.container.querySelector('[data-chooser]') as HTMLElement;
    expect(picker).not.toBeNull();
    // Drawn OUTSIDE the screen's subtree and outside the plugin's sheet (and its scrim and focus trap) ...
    expect(view.container.querySelector('[data-testid="sheet-screen"]')?.contains(picker)).toBe(false);
    expect(pluginSheet.contains(picker)).toBe(false);
    // ... as its own overlay on the frame root, painted ABOVE the plugin's z-40 overlay, modal, with its own focus.
    const overlay = picker.closest('[data-bottom-sheet]') as HTMLElement;
    expect(overlay.className).toContain('kt-overlay');
    expect(overlay.className).toContain('z-50');
    expect(overlay.parentElement).toBe(view.container.querySelector('.fy-frame'));
    const dialog = overlay.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe(picker.querySelector('h2')?.id ?? 'none');
    expect(picker.querySelector('h2')?.textContent).toBe('Install on which machine?');
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Picking answers the question while the plugin's sheet is still open, and the call rides the chosen machine.
    await click(view, '[data-chooser-machine="d1"]');
    expect(view.container.querySelector('[data-chooser]')).toBeNull();
    expect(view.container.querySelector('[data-bottom-sheet="plugin-sheet"]')).not.toBeNull();
    expect(answers.chosen[0]?.daemon).toBe('d1');
    expect(answers.previews).toEqual([{ ok: 'd1' }]);
    expect(transportOf('d1').paths()).toContain('GET /v1/asker/preview');
    expect(transportOf('d2').paths()).not.toContain('GET /v1/asker/preview');
    await view.unmount();
  });

  test('S10 M1 Escape closes the picker first and leaves the plugin’s sheet open', async () => {
    go('/sheet');
    const { app } = setup(provision().made);
    const view = await mount(app);
    await settle();
    await click(view, '[data-testid="sheet-install"]');
    await interact(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle();
    expect(answers.chosen).toEqual([undefined]);
    expect(view.container.querySelector('[data-chooser]')).toBeNull();
    expect(view.container.querySelector('[data-bottom-sheet="plugin-sheet"]')).not.toBeNull();
    await view.unmount();
  });

  test('S10 m3 two machines with one name are told apart in the picker and in the answer', async () => {
    go('/ask');
    const { app, daemons } = setup(provision().made);
    daemons.add({ daemon: 'd4', machine: 'laptop', deviceId: 'dev', address: 'http://192.168.1.9:40245' });
    const view = await mount(app);
    await settle();
    await click(view, '[data-testid="ask"]');
    const labels = [...view.container.querySelectorAll('[data-chooser-machine]')].map(node => node.textContent);
    expect(new Set(labels).size).toBe(labels.length);
    // The loopback twin is numbered, never named by its address; the off-host twin keeps its address.
    expect(labels).toContain('laptop (1)');
    expect(labels).toContain('laptop (192.168.1.9:40245)');
    expect(labels.join(' ')).not.toContain('127.0.0.1');
    await click(view, '[data-chooser-machine="d1"]');
    expect(answers.chosen[0]?.machine).toBe('laptop (1)');
    await view.unmount();
  });

  test('S10 cancel answers undefined and gives no client', async () => {
    go('/ask');
    const { app } = setup(provision().made);
    const view = await mount(app);
    await settle();
    await click(view, '[data-testid="ask"]');
    await click(view, '[data-chooser-cancel]');
    expect(answers.chosen).toEqual([undefined]);
    expect(view.container.querySelector('[data-chooser]')).toBeNull();
    await view.unmount();
  });

  test('S10 a choice answers this plugin’s own client on that machine and the name picked', async () => {
    go('/ask');
    const { app } = setup(provision().made);
    const view = await mount(app);
    await settle();
    await click(view, '[data-testid="ask"]');
    await click(view, '[data-chooser-machine="d1"]');
    const chosen = answers.chosen[0];
    expect(chosen?.daemon).toBe('d1');
    expect(chosen?.machine).toBe('laptop');
    expect(answers.previews).toEqual([{ ok: 'd1' }]);
    await view.unmount();
  });

  test('S10 a new question cancels the one still open', async () => {
    go('/ask');
    const { app } = setup(provision().made);
    const view = await mount(app);
    await settle();
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    await interact(() => {
      first = chooseFn?.('First?');
      second = chooseFn?.('Second?');
    });
    await settle();
    expect(await first).toBeUndefined();
    expect(view.container.querySelector('[data-chooser] h2')?.textContent).toBe('Second?');
    await click(view, '[data-chooser-cancel]');
    expect(await second).toBeUndefined();
    await view.unmount();
  });

  test('S10 with no machine to offer the picker says so and can still be closed', async () => {
    go('/ask');
    const { app, daemons } = setup(provision().made);
    for (const paired of daemons.snapshot().daemons) daemons.remove(paired.daemon);
    const view = await mount(app);
    await settle();
    let asked: Promise<unknown> | undefined;
    await interact(() => {
      asked = chooseFn?.('Anywhere?');
    });
    await settle();
    expect(view.container.querySelector('[data-chooser-none]')).not.toBeNull();
    await click(view, '[data-chooser-cancel]');
    expect(await asked).toBeUndefined();
    await view.unmount();
  });

  test('S10 after a choice of a locked machine the install preview’s GET runs once the passkey is confirmed', async () => {
    go('/ask');
    // The person's click on the machine is the browser's transient user activation: the read it causes may ask
    // (a read sent with none — a poll — never does, A555 r7).
    const activation = Object.getOwnPropertyDescriptor(navigator, 'userActivation');
    Object.defineProperty(navigator, 'userActivation', { value: { isActive: true }, configurable: true });
    const { made, asked } = provision();
    const { app, transportOf } = setup(made);
    const view = await mount(app);
    await settle();
    await click(view, '[data-testid="ask"]');
    // Nothing is chosen yet, so a read of d2 would wait for its prompt.
    await click(view, '[data-chooser-machine="d2"]');
    await settle();
    expect(asked).toEqual([{ kind: 'step-up' }]);
    expect(
      transportOf('d2')
        .paths()
        .filter(path => path === 'GET /v1/asker/preview'),
    ).toHaveLength(2);
    expect(answers.previews).toEqual([{ ok: 'd2' }]);
    await view.unmount();
    if (activation === undefined) Reflect.deleteProperty(navigator, 'userActivation');
    else Object.defineProperty(navigator, 'userActivation', activation);
  });

  test('S10 only PasskeyMount calls focus: the chooser sets an override and the prompt follows it', async () => {
    go('/ask');
    const { made, focused } = provision();
    const { app, daemons } = setup(made);
    const view = await mount(app);
    await settle();
    const selected = daemons.snapshot().selected;
    expect(focused.at(-1)).toBe(selected);
    const before = focused.length;
    await click(view, '[data-testid="ask"]');
    // Opening the picker moves nothing.
    expect(focused.length).toBe(before);
    await click(view, '[data-chooser-machine="d2"]');
    expect(focused.at(-1)).toBe('d2');
    await view.unmount();
  });

  test('S10 unmounting the chooser hands the prompt back to the route’s machine', async () => {
    go('/ask');
    const { made, focused } = provision();
    const { app, daemons, runtime } = setup(made);
    const view = await mount(app);
    await settle();
    const selected = daemons.snapshot().selected;
    await click(view, '[data-testid="ask"]');
    await click(view, '[data-chooser-machine="d2"]');
    expect(runtime.passkeyOnScreen.chosen()).toBe('d2');
    // Leaving the screen (any navigation) releases the override.
    await interact(() => {
      window.history.pushState({}, '', '/other');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await settle();
    expect(view.container.querySelector('[data-testid="other"]')).not.toBeNull();
    expect(runtime.passkeyOnScreen.chosen()).toBeUndefined();
    expect(focused.at(-1)).toBe(selected);
    await view.unmount();
  });

  test('S10 two choosers in turn never clear each other’s override', () => {
    const { made } = provision();
    const { runtime } = setup(made);
    const releaseFirst = runtime.passkeyOnScreen.choose('d1');
    const releaseSecond = runtime.passkeyOnScreen.choose('d2');
    // The first screen goes: the second's choice stays on screen.
    releaseFirst();
    expect(runtime.passkeyOnScreen.chosen()).toBe('d2');
    releaseSecond();
    expect(runtime.passkeyOnScreen.chosen()).toBeUndefined();
    // A release that runs twice clears nothing of a later choice.
    const releaseThird = runtime.passkeyOnScreen.choose('d1');
    releaseSecond();
    expect(runtime.passkeyOnScreen.chosen()).toBe('d1');
    releaseThird();
  });

  test('S10 a machine that went away between the list and the click is not handed out', async () => {
    go('/ask');
    const { app, daemons } = setup(provision().made);
    const view = await mount(app);
    await settle();
    await click(view, '[data-testid="ask"]');
    await interact(() => {
      daemons.remove('d2');
    });
    await settle();
    await click(view, '[data-chooser-cancel]');
    expect(answers.chosen).toEqual([undefined]);
    await view.unmount();
  });
});

describe('S10 answerAloneWhenOne: the shell answers alone only when exactly one machine qualifies', () => {
  const ALONE = { answerAloneWhenOne: true } as const;
  const pairOnly = (daemons: DaemonList, keep: readonly string[]): void => {
    for (const paired of daemons.snapshot().daemons) if (!keep.includes(paired.daemon)) daemons.remove(paired.daemon);
  };
  /** Asks, lets the shell settle, and reports what the question holds NOW: `'pending'` while it waits on a click. */
  const ask = async (options: Parameters<NonNullable<typeof chooseFn>>[1]) => {
    const state: { value: ChosenDaemon | undefined | 'pending' } = { value: 'pending' };
    await interact(() => {
      void chooseFn?.('Install on which machine?', options).then(answer => {
        state.value = answer;
      });
    });
    await settle();
    return state;
  };

  /** Opens every machine's connection (a first look does) and lets each answer, as a page that has been up a while. */
  const warm = async (view: { container: HTMLElement }): Promise<void> => {
    await ask(undefined);
    await click(view, '[data-chooser-cancel]');
  };

  test('ONE machine paired at all, and it qualifies, is answered at once, with no picker', async () => {
    go('/ask');
    const { app, daemons, transportOf, runtime } = setup(provision().made);
    pairOnly(daemons, ['d1']);
    const view = await mount(app);
    await settle();
    await warm(view);
    const chosen = (await ask(ALONE)).value as ChosenDaemon;
    expect(view.container.querySelector('[data-chooser]')).toBeNull();
    expect(chosen.daemon).toBe('d1');
    expect(chosen.machine).toBe('laptop');
    // The answer carries THAT machine's own client, and it is the machine on screen.
    await chosen.client.call('GET /v1/asker/preview');
    expect(transportOf('d1').paths()).toContain('GET /v1/asker/preview');
    expect(runtime.passkeyOnScreen.chosen()).toBe('d1');
    await view.unmount();
  });

  test('the one paired machine need not be the first, nor the one the page started on', async () => {
    go('/ask');
    const { app, daemons, transportOf } = setup(provision().made);
    pairOnly(daemons, ['d2']);
    const view = await mount(app);
    await settle();
    await warm(view);
    const chosen = (await ask(ALONE)).value as ChosenDaemon;
    expect(chosen.daemon).toBe('d2');
    // d2 refuses its first preview for a step-up, and nobody is pressing anything here: the refusal is the answer.
    await chosen.client.call('GET /v1/asker/preview').catch(() => undefined);
    expect(transportOf('d2').paths()).toContain('GET /v1/asker/preview');
    expect(transportOf('d1').paths()).not.toContain('GET /v1/asker/preview');
    await view.unmount();
  });

  /** Two machines paired, the second in a state that is not "qualifying": the person is still ASKED (v4 counted both). */
  const pairedPair = async (
    options: Parameters<typeof setup>[1],
    slow: Parameters<typeof setup>[2],
    bad: Parameters<typeof setup>[3],
    keep: readonly string[],
  ) => {
    go('/ask');
    const parts = setup(provision().made, options, slow, bad);
    pairOnly(parts.daemons, keep);
    const view = await mount(parts.app);
    await settle();
    await warm(view);
    const asked = await ask(ALONE);
    return { view, asked };
  };

  test('two paired and the second UNREADABLE (plugin list failed): the picker, not the first machine alone', async () => {
    const { view, asked } = await pairedPair([], [], { unreadable: ['d2'] }, ['d1', 'd2']);
    expect(asked.value).toBe('pending');
    expect(view.container.querySelector('[data-chooser-machine="d1"]')).not.toBeNull();
    expect(view.container.querySelector('[data-chooser-machine="d2"]')).toBeNull();
    await click(view, '[data-chooser-cancel]');
    await view.unmount();
  });

  test('two paired and the second UNREACHABLE: the picker', async () => {
    const { view, asked } = await pairedPair(['d2'], [], {}, ['d1', 'd2']);
    expect(asked.value).toBe('pending');
    expect(view.container.querySelector('[data-chooser-machine="d1"]')).not.toBeNull();
    await click(view, '[data-chooser-cancel]');
    await view.unmount();
  });

  test('two paired and the second REFUSED this device: the picker', async () => {
    const { view, asked } = await pairedPair([], [], { refused: ['d2'] }, ['d1', 'd2']);
    expect(asked.value).toBe('pending');
    expect(view.container.querySelector('[data-chooser-machine="d1"]')).not.toBeNull();
    await click(view, '[data-chooser-cancel]');
    await view.unmount();
  });

  test('two paired and the second has the plugin OFF (a read verdict): the picker', async () => {
    const { view, asked } = await pairedPair([], [], {}, ['d1', 'd3']);
    expect(asked.value).toBe('pending');
    expect(view.container.querySelector('[data-chooser-machine="d1"]')).not.toBeNull();
    expect(view.container.querySelector('[data-chooser-machine="d3"]')).toBeNull();
    await click(view, '[data-chooser-machine="d1"]');
    expect((asked.value as ChosenDaemon).daemon).toBe('d1');
    await view.unmount();
  });

  test('two paired and the second still CONNECTING: the picker', async () => {
    const { view, asked } = await pairedPair([], ['d2'], {}, ['d1', 'd2']);
    expect(asked.value).toBe('pending');
    expect(view.container.querySelector('[data-chooser-machine="d1"]')).not.toBeNull();
    await click(view, '[data-chooser-machine="d1"]');
    expect((asked.value as ChosenDaemon).daemon).toBe('d1');
    await view.unmount();
  });

  test('one paired machine that does not qualify (down, plugin off, connecting, unreadable) is never the one', async () => {
    const lone = async (
      options: Parameters<typeof setup>[1],
      slow: Parameters<typeof setup>[2],
      bad: Parameters<typeof setup>[3],
      keep: string,
    ) => {
      go('/ask');
      const parts = setup(provision().made, options, slow, bad);
      pairOnly(parts.daemons, [keep]);
      const view = await mount(parts.app);
      await settle();
      await warm(view);
      const asked = await ask(ALONE);
      expect(asked.value).toBe('pending');
      expect(view.container.querySelector('[data-chooser-none]')).not.toBeNull();
      await click(view, '[data-chooser-cancel]');
      expect(asked.value).toBeUndefined();
      await view.unmount();
    };
    await lone(['d1'], [], {}, 'd1');
    await lone([], [], {}, 'd3');
    await lone([], ['d1'], {}, 'd1');
    await lone([], [], { unreadable: ['d1'] }, 'd1');
    await lone([], [], { refused: ['d1'] }, 'd1');
  });

  test('two qualifying machines still ask', async () => {
    go('/ask');
    const { app } = setup(provision().made);
    const view = await mount(app);
    await settle();
    await warm(view);
    const asked = await ask(ALONE);
    const listed = [...view.container.querySelectorAll('[data-chooser-machine]')].map(node =>
      node.getAttribute('data-chooser-machine'),
    );
    expect(listed.toSorted()).toEqual(['d1', 'd2']);
    expect(asked.value).toBe('pending');
    await click(view, '[data-chooser-machine="d2"]');
    expect((asked.value as ChosenDaemon).daemon).toBe('d2');
    await view.unmount();
  });

  test('without the option, even one qualifying machine asks (every other caller is unchanged)', async () => {
    go('/ask');
    const { app, daemons } = setup(provision().made);
    pairOnly(daemons, ['d1']);
    const view = await mount(app);
    await settle();
    await warm(view);
    const asked = await ask(undefined);
    expect(view.container.querySelector('[data-chooser-machine="d1"]')).not.toBeNull();
    expect(asked.value).toBe('pending');
    // An explicit false is the same as absent.
    await click(view, '[data-chooser-cancel]');
    const explicit = await ask({ answerAloneWhenOne: false });
    expect(view.container.querySelector('[data-chooser-machine="d1"]')).not.toBeNull();
    expect(explicit.value).toBe('pending');
    await click(view, '[data-chooser-cancel]');
    await view.unmount();
  });

  test('an alone answer cancels a question still open, and its override goes with the screen', async () => {
    go('/ask');
    const { app, daemons, runtime } = setup(provision().made);
    pairOnly(daemons, ['d1', 'd2']);
    const view = await mount(app);
    await settle();
    await warm(view);
    let first: Promise<unknown> | undefined;
    await interact(() => {
      first = chooseFn?.('First?');
    });
    await settle();
    await interact(() => {
      daemons.remove('d2');
    });
    const chosen = (await ask(ALONE)).value as ChosenDaemon;
    expect(await first).toBeUndefined();
    expect(chosen.daemon).toBe('d1');
    expect(view.container.querySelector('[data-chooser]')).toBeNull();
    await interact(() => {
      window.history.pushState({}, '', '/other');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await settle();
    expect(runtime.passkeyOnScreen.chosen()).toBeUndefined();
    await view.unmount();
  });
});
