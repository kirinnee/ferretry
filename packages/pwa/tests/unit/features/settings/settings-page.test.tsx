import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ConnectionChoice } from '@ferretry/relay';
import { type ReactNode, useLayoutEffect, useState } from 'react';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import type { FleetClientFactory } from '../../../../src/features/fleet/fleet-client.ts';
import { useSettingsFlow } from '../../../../src/features/fleet/setup/settings-route.ts';
import type { MachineTabProps, MachineTabSurfaces } from '../../../../src/features/fleet/shell/machines-surface.tsx';
import { DaemonHostChecks, type DaemonReachabilityProbe } from '../../../../src/features/settings/daemon-settings.tsx';
import type { DaemonSettingsTabDefinition } from '../../../../src/features/settings/daemon-settings-frame.tsx';
import { SettingsPage, SettingsScope } from '../../../../src/features/settings/settings-page.tsx';
import type { WardenClientFactory } from '../../../../src/features/warden/warden-config-card.tsx';
import type { DaemonConnectionRecord } from '../../../../src/lib/connections.ts';
import { type ControlsStorage, DaemonControlsStore } from '../../../../src/lib/controls.ts';
import { type DaemonId, daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { DEFAULT_STT_SETTINGS } from '../../../../src/lib/stt/stt-settings.ts';
import { UNSUPPORTED_RECOGNITION } from '../../../support/browser-recognition.ts';
import { interact, mount, must } from '../../../support/dom.ts';
import { render, run } from '../../../support/react.ts';
import { machineClient, machineView } from '../fleet/shell/machine-support.ts';

const memoryStorage = (): ControlsStorage => {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

const pendingProbe: DaemonReachabilityProbe = () => new Promise(() => undefined);
const unavailableWardenClient: WardenClientFactory = async () =>
  Promise.reject(new Error('Warden unavailable in this test.'));

const daemon = (id: string, baseUrl: string, deviceId: string, label?: string): DaemonConnectionRecord => ({
  ...daemonConnection({ daemonId: id, baseUrl, deviceId }),
  ...(label === undefined ? {} : { label }),
  pairedAt: 1,
  lastSelectedAt: 2,
});

const alpha = daemon('daemon-alpha', 'https://alpha.example.test', 'alpha-secret', 'Alpha workstation');
const beta = daemon('daemon-beta', 'https://beta.example.test', 'beta-secret');
const originalFetch = globalThis.fetch;
const unavailableDaemonFetch = (async () => Response.json({}, { status: 503 })) as unknown as typeof fetch;

/** A machine that answers with its setup, so the Machines section has something to show. */
const answering: FleetClientFactory = async () => machineClient(machineView({ name: 'alpha-host' }));

/**
 * The Machine tab as far as this page is concerned: the daemon's panels, opened by the address.
 *
 * The real tab (`settings-tab.tsx`) is tested on its own; here it is the narrowest surface that reads
 * the panel word from the address the way the real one does, so these tests are about what the PAGE
 * hands the tab — the routed daemon's frame and its pairing record — and not about the tab's sections.
 */
const PanelsTab = ({ machineName, daemonPanels }: MachineTabProps) => {
  const route = useSettingsFlow(machineName);
  return <>{daemonPanels?.(route.panel ?? undefined, route.openPanel)}</>;
};
const PANEL_TABS: MachineTabSurfaces = { machine: PanelsTab };

/**
 * Stable, as the composition root's memoised list is: the frame defaults a missing list to a fresh `[]`
 * on every render, which would remount every panel — and re-run its probe — each time the page re-renders.
 */
const NO_EXTRA_PANELS: readonly DaemonSettingsTabDefinition[] = [];

interface Callbacks {
  readonly renamed: Array<{ id: string; label: string | undefined }>;
  readonly removed: string[];
  readonly added: string[];
  readonly navigated: string[];
  readonly named?: string[];
}

const calls = (): Callbacks => ({ renamed: [], removed: [], added: [], navigated: [] });

interface PageOptions {
  readonly current?: DaemonConnectionRecord;
  readonly connections?: readonly DaemonConnectionRecord[];
  readonly controls?: DaemonControlsStore;
  readonly probe?: DaemonReachabilityProbe;
  readonly carrier?: ConnectionChoice;
  readonly calls?: Callbacks;
  readonly createMachineClient?: FleetClientFactory;
  readonly machineTabs?: MachineTabSurfaces;
  readonly lockedMachines?: readonly DaemonId[];
  /** Leave out onNavigate, as a page composed without a router would. */
  readonly routerless?: boolean;
  /** The host's way to empty this device's cache; absent where it keeps none. */
  readonly onClearCachedData?: () => Promise<void>;
  /** This device › Connection, as the host composes it. */
  readonly connectionPreferences?: ReactNode;
}

const page = (options: PageOptions = {}) => {
  const current = options.current ?? alpha;
  const callbacks = options.calls ?? calls();
  return (
    <SettingsPage
      daemonId={current.daemonId}
      connections={options.connections ?? [current]}
      controls={options.controls ?? new DaemonControlsStore(memoryStorage())}
      dictation={{
        settings: DEFAULT_STT_SETTINGS,
        update: () => {},
        persisted: true,
        // Dictation is not the subject of this suite: pin detection rather
        // than letting it read whatever the test DOM happens to expose.
        recognitionSupport: UNSUPPORTED_RECOGNITION,
      }}
      probeDaemon={options.probe ?? pendingProbe}
      {...(options.carrier === undefined ? {} : { carrier: options.carrier })}
      createWardenClient={unavailableWardenClient}
      daemonSettingsTabs={NO_EXTRA_PANELS}
      onRenameDaemon={(id, label) => callbacks.renamed.push({ id, label })}
      {...(callbacks.named === undefined
        ? {}
        : { onMachineNamed: (id: DaemonId, name: string) => callbacks.named?.push(`${String(id)}=${name}`) })}
      onRemoveDaemon={id => callbacks.removed.push(id)}
      onAddDaemon={() => callbacks.added.push('add')}
      {...(options.onClearCachedData === undefined ? {} : { onClearCachedData: options.onClearCachedData })}
      {...(options.connectionPreferences === undefined ? {} : { connectionPreferences: options.connectionPreferences })}
      {...(options.routerless === true ? {} : { onNavigate: (to: string) => callbacks.navigated.push(to) })}
      {...(options.createMachineClient === undefined ? {} : { createMachineClient: options.createMachineClient })}
      {...(options.machineTabs === undefined ? {} : { machineTabs: options.machineTabs })}
      {...(options.lockedMachines === undefined ? {} : { lockedMachines: options.lockedMachines })}
    />
  );
};

/** A page whose Machine tab shows the routed daemon's panels, opened at one of them. */
const panelsPage = (options: PageOptions = {}) =>
  page({ createMachineClient: answering, machineTabs: PANEL_TABS, ...options });

const ALPHA_MACHINE = '#machines/Alpha%20workstation/machine';

const settingIds = (view: ReactTestRenderer): string[] =>
  view.root
    .findAll(node => node.props['data-setting-id'] !== undefined)
    .map(section => String(section.props['data-setting-id']));

/** Every switch inside one setting's own panel, in rendered order. */
const settingSwitches = (view: ReactTestRenderer, id: string) =>
  view.root.findByProps({ 'data-setting-id': id }).findAllByProps({ role: 'switch' });

const sidebar = (container: HTMLElement): HTMLElement =>
  must(container.querySelector<HTMLElement>('[data-settings-sidebar]'), 'the desktop sidebar');

const shownSection = (container: HTMLElement): string | null =>
  container.querySelector('[data-settings-section]')?.getAttribute('data-settings-section') ?? null;

/** Moves the address the way a link or the back button does, and lets the page follow it. */
const visit = async (hash: string, event: 'hashchange' | 'popstate' = 'hashchange'): Promise<void> => {
  window.history.replaceState({}, '', `${window.location.pathname}${hash}`);
  await interact(() =>
    window.dispatchEvent(event === 'hashchange' ? new Event('hashchange') : new PopStateEvent('popstate')),
  );
};

const hostChecks = (container: HTMLElement, id: string): HTMLElement =>
  must(container.querySelector<HTMLElement>(`[data-daemon-host-checks="${id}"]`), `${id} host checks`);

const reachability = (container: HTMLElement, id: string): string | null =>
  hostChecks(container, id).querySelector('[data-daemon-reachability]')?.getAttribute('data-daemon-reachability') ??
  null;

const writeInput = async (input: HTMLInputElement, value: string): Promise<void> => {
  const setter = must(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set, 'input setter');
  await interact(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

const deferred = <T,>(): Deferred<T> => {
  let resolve = (_value: T): void => undefined;
  let reject = (_reason: unknown): void => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(() => {
  window.history.replaceState({}, '', '/d/daemon-alpha/settings');
  // These page-routing assertions mount daemon-owned panels but do not exercise
  // their transports. Keep each optional panel on an explicit unavailable fixture.
  globalThis.fetch = unavailableDaemonFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('SettingsPage sections', () => {
  it('owns one scroll region and starts with the four Appearance settings in stable order', () => {
    const view = render(page());
    const scroller = view.root.findByProps({ 'data-settings-scroller': true });
    const sidebarChoices = view.root
      .findByProps({ 'data-settings-sidebar': '' })
      .findAll(node => node.props['data-settings-section-choice'] !== undefined && node.type === 'button');

    expect(scroller.props.className).toContain('overflow-y-auto');
    // Daemons is no longer a section: the browser's own three sections, and then each machine by name.
    expect(sidebarChoices.map(choice => choice.props['data-settings-section-choice'])).toEqual([
      'appearance',
      'behaviour',
      'device',
    ]);
    expect(sidebarChoices.map(choice => choice.props['aria-current'])).toEqual(['page', undefined, undefined]);
    expect(settingIds(view)).toEqual([
      'text-size',
      'theme',
      'motion',
      'density',
      'group-needs-you',
      'chat-width',
      'open-links-in',
      'message-marks',
    ]);
    expect(view.root.findByProps({ 'data-settings-section': 'appearance' }).props.id).toBe('settings-section-panel');

    run(() => view.unmount());
  });

  it('groups Needs you by default and the switch turns it off for this device', () => {
    const controls = new DaemonControlsStore(memoryStorage());
    const view = render(page({ controls }));
    expect(controls.snapshot().device.groupNeedsYou).toBe(true);
    const [toggle] = settingSwitches(view, 'group-needs-you');
    run(() => toggle?.props.onClick?.());
    expect(controls.snapshot().device.groupNeedsYou).toBe(false);
    run(() => view.unmount());
  });

  it('opens a section by moving the address, and shows only the section the address names', async () => {
    const callbacks = calls();
    const view = await mount(page({ connections: [alpha, beta], calls: callbacks }));

    // A section is an address: choosing one asks the router, rather than holding it as private state.
    await interact(() =>
      must(
        sidebar(view.container).querySelector<HTMLButtonElement>('[data-settings-section-choice="behaviour"]'),
        'the Behaviour choice',
      ).click(),
    );
    expect(callbacks.navigated).toEqual(['/d/daemon-alpha/settings#behaviour']);

    await visit('#behaviour');
    expect(shownSection(view.container)).toBe('behaviour');
    expect(
      [...view.container.querySelectorAll('[data-setting-id]')].map(node => node.getAttribute('data-setting-id')),
    ).toEqual([
      'sessions-list',
      'composer-markdown',
      'composer-enter-key',
      'composer-suggestions',
      'dictation',
      'notifications',
    ]);
    expect(view.container.querySelector('[data-settings-section="appearance"]')).toBeNull();
    expect(
      sidebar(view.container).querySelector('[data-settings-section-choice="behaviour"]')?.getAttribute('aria-current'),
    ).toBe('page');
    expect(
      sidebar(view.container)
        .querySelector('[data-settings-section-choice="appearance"]')
        ?.getAttribute('aria-current'),
    ).toBeNull();
    await view.unmount();
  });

  it('renders Cached data in This device and wires it to the host’s clear', async () => {
    // Arrange
    let cleared = 0;
    const view = await mount(
      page({
        onClearCachedData: async () => {
          cleared += 1;
        },
      }),
    );
    try {
      // Act
      await visit('#device');
      const setting = must(
        view.container.querySelector<HTMLElement>('[data-setting-id="clear-cached-data"]'),
        'the Cached data setting',
      );
      const press = async (label: string): Promise<void> =>
        interact(() =>
          must(
            [...setting.querySelectorAll('button')].find(node => node.textContent?.includes(label)),
            label,
          ).click(),
        );
      await press('Clear cached data');
      await press('Clear');

      // Assert
      expect(shownSection(view.container)).toBe('device');
      expect(setting.querySelector('[data-clear-cached-data]')?.getAttribute('data-clear-cached-data')).toBe('cleared');
      expect(cleared).toBe(1);
    } finally {
      await view.unmount();
    }
  });

  it('lists the device permissions under This device, and reads without asking', async () => {
    // Arrange
    const view = await mount(page());
    try {
      // Act
      await visit('#device');

      // Assert
      const setting = must(
        view.container.querySelector<HTMLElement>('[data-setting-id="device-permissions"]'),
        'the Permissions setting',
      );
      expect(setting.textContent).toContain('Permissions');
      expect(shownSection(view.container)).toBe('device');
    } finally {
      await view.unmount();
    }
  });

  it('lists this device’s connection choice for each machine under This device, or says why it cannot', async () => {
    // Arrange
    const composed = await mount(page({ connectionPreferences: <p data-composed-preferences="">per machine</p> }));
    try {
      // Act
      await visit('#device');

      // Assert
      const setting = must(
        composed.container.querySelector<HTMLElement>('[data-setting-id="connection-preference"]'),
        'the Connection setting',
      );
      expect(setting.textContent).toContain('Connection');
      expect(setting.querySelector('[data-composed-preferences]')).not.toBeNull();
    } finally {
      await composed.unmount();
    }
    const bare = await mount(page());
    try {
      await visit('#device');
      expect(bare.container.querySelector('[data-setting-id="connection-preference"]')?.textContent).toContain(
        'The connection choice is unavailable',
      );
    } finally {
      await bare.unmount();
    }
  });

  it('says a host without a cache keeps no cached data', async () => {
    // Arrange
    const view = await mount(page());
    try {
      // Act
      await visit('#device');

      // Assert
      expect(view.container.querySelector('[data-setting-id="clear-cached-data"]')?.textContent).toContain(
        'This copy of Ferretry keeps no cached data.',
      );
    } finally {
      await view.unmount();
    }
  });

  it('persists the composer suggestion families and Vim keys as shared device controls', () => {
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#behaviour');
    const storage = memoryStorage();
    const controls = new DaemonControlsStore(storage);
    const view = render(page({ controls }));

    const keys = () =>
      view.root
        .findByProps({ 'data-setting-id': 'composer-suggestions' })
        .findAll(node => node.type === 'input' && node.props.type === 'radio');
    expect(keys().map(radio => radio.props.checked)).toEqual([true, false, false]);

    // Choosing the symbols moves only the keys; $ skills is untouched.
    run(() => keys()[1]?.props.onChange());
    expect(keys().map(radio => radio.props.checked)).toEqual([false, true, false]);
    expect(controls.snapshot().device.suggestionKeys).toBe('symbols');
    expect(controls.snapshot().device.skillSuggestions).toBe(true);
    expect(settingSwitches(view, 'composer-suggestions').map(control => control.props['aria-checked'])).toEqual([true]);

    // Vim shares the composer-editing control with the editor style, and is
    // the one switch there rather than a page of its own.
    const editing = settingSwitches(view, 'composer-markdown');
    expect(editing).toHaveLength(1);
    expect(editing[0]?.props['aria-checked']).toBe(false);
    run(() => editing[0]?.props.onClick());
    expect(controls.snapshot().device.composerVimMode).toBe(true);
    expect(settingSwitches(view, 'composer-markdown')[0]?.props['aria-checked']).toBe(true);

    // The phone's return key persists the same way.
    const radio = (id: string, name: string, value: string) =>
      view.root
        .findByProps({ 'data-setting-id': id })
        .findAll(node => node.type === 'input' && node.props.name === name && node.props.value === value)[0];
    run(() => radio('composer-enter-key', 'composer-phone-enter-key', 'send')?.props.onChange());
    expect(controls.snapshot().device.composerPhoneEnterKey).toBe('send');

    // The session list can show the machine on screen alone, on this device.
    run(() => radio('sessions-list', 'behaviour-sessions-list', 'current')?.props.onChange());
    expect(controls.snapshot().device.sessionsList).toBe('current');

    // Both are properties of this screen: they survive a reload and read the
    // same for a daemon this page never named.
    const reloaded = new DaemonControlsStore(storage);
    expect(reloaded.controls(beta.daemonId).suggestionKeys).toBe('symbols');
    expect(reloaded.controls(beta.daemonId).composerVimMode).toBe(true);

    run(() => view.unmount());
  });

  it('keeps where links open as a plain two-way device choice, Your browser by default', () => {
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#appearance');
    const storage = memoryStorage();
    const controls = new DaemonControlsStore(storage);
    const view = render(page({ controls }));

    const row = view.root.findByProps({ 'data-setting-id': 'open-links-in' });
    const choices = () => row.findAll(node => node.type === 'input' && node.props.name === 'appearance-open-links-in');
    const text = (node: ReactTestInstance): string =>
      node.children.map(child => (typeof child === 'string' ? child : text(child))).join('');
    expect(text(row)).toContain('Open links in');
    expect(text(row)).toContain('Your browser');
    expect(text(row)).toContain('Ferretry side panel');
    expect(text(row)).toContain('Cmd/Ctrl-click always opens a new tab.');
    expect(choices().map(radio => [radio.props.value, radio.props.checked])).toEqual([
      ['browser', true],
      ['panel', false],
    ]);

    run(() => choices()[1]?.props.onChange());
    expect(controls.snapshot().device.openLinksIn).toBe('panel');
    expect(choices().map(radio => radio.props.checked)).toEqual([false, true]);
    // A property of this screen: it survives a reload.
    expect(new DaemonControlsStore(storage).snapshot().device.openLinksIn).toBe('panel');

    run(() => view.unmount());
  });

  it('follows setting and section hashes, while ignoring an unknown hash', async () => {
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#dictation');
    const view = await mount(page());

    expect(shownSection(view.container)).toBe('behaviour');

    await visit('#density');
    expect(shownSection(view.container)).toBe('appearance');
    expect(document.activeElement?.id).toBe('settings-density');

    await visit('#behaviour', 'popstate');
    expect(shownSection(view.container)).toBe('behaviour');

    // An unknown word is Settings' own first screen, never another section's controls.
    await visit('#not-a-setting');
    expect(view.container.querySelector('main')?.getAttribute('data-settings-at-home')).toBe('true');
    expect(shownSection(view.container)).toBe('appearance');
    await view.unmount();
  });
});

describe('SettingsPage on a phone: one level per screen', () => {
  it('opens on the grouped cards, with the section beside them hidden on a phone', async () => {
    const callbacks = calls();
    const view = await mount(page({ connections: [alpha, beta], calls: callbacks }));
    const main = must(view.container.querySelector<HTMLElement>('main'), 'the page');
    const home = must(view.container.querySelector<HTMLElement>('[data-settings-home]'), 'the phone home');
    const section = must(view.container.querySelector<HTMLElement>('#settings-section-panel'), 'the section');

    expect(main.getAttribute('data-settings-at-home')).toBe('true');
    // The phone's first screen sits on the recessed ground; the desktop never does.
    expect(main.className).toContain('max-md:bg-ground');
    expect(must(home.parentElement, 'the home column').className).toContain('md:hidden');
    // The open section is still what a desktop shows beside the sidebar, and nothing on a phone.
    expect(must(section.parentElement, 'the section column').className).toContain('hidden md:block');

    expect(home.textContent).toContain('This device');
    expect(home.textContent).toContain('Machines · 2');
    expect(
      [...home.querySelectorAll('[data-settings-machine]')].map(row => row.getAttribute('data-settings-machine')),
    ).toEqual(['daemon-alpha', 'daemon-beta']);

    // Each card row is an address, like the sidebar's.
    await interact(() =>
      must(home.querySelector<HTMLButtonElement>('[data-settings-section-choice="appearance"]'), 'Appearance').click(),
    );
    await interact(() =>
      must(home.querySelector<HTMLButtonElement>('[data-settings-machine="daemon-beta"]'), 'Beta').click(),
    );
    await interact(() => must(home.querySelector<HTMLButtonElement>('[data-machine-add]'), 'Add a machine').click());
    expect(callbacks.navigated).toEqual([
      '/d/daemon-alpha/settings#appearance',
      `/d/daemon-beta/settings#machines/${encodeURIComponent(beta.baseUrl)}/runtimes`,
    ]);
    expect(callbacks.added).toEqual(['add']);
    await view.unmount();
  });

  it('shows one section on its own screen with “‹ Settings” back to the cards', async () => {
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#behaviour');
    const callbacks = calls();
    const view = await mount(page({ calls: callbacks }));
    const main = must(view.container.querySelector<HTMLElement>('main'), 'the page');
    const back = must(view.container.querySelector<HTMLButtonElement>('[data-settings-back]'), 'the back button');

    expect(main.getAttribute('data-settings-at-home')).toBe('false');
    expect(main.className).not.toContain('max-md:bg-ground');
    expect(view.container.querySelector('[data-settings-home]')).toBeNull();
    expect(back.textContent).toBe('Settings');
    expect(must(back.parentElement, 'the back row').className).toContain('md:hidden');

    await interact(() => back.click());
    expect(callbacks.navigated).toEqual(['/d/daemon-alpha/settings']);
    await view.unmount();
  });
});

describe('SettingsScope', () => {
  const scope = async (element: ReturnType<typeof SettingsScope>): Promise<HTMLElement> => {
    const view = await mount(element);
    return must(view.container.querySelector<HTMLElement>('[data-settings-scope]'), 'the scope line');
  };

  it('says a machine’s settings are its daemon’s, shared by every device paired to it', async () => {
    const line = await scope(<SettingsScope scope="machine" machineName="Alpha workstation" />);
    expect(line.getAttribute('data-settings-scope')).toBe('machine');
    expect(line.textContent).toBe(
      'This machineAlpha workstation’s daemon settings, shared by every device paired to it.',
    );
  });

  it('says the same without a name when none is known', async () => {
    const line = await scope(<SettingsScope scope="machine" />);
    expect(line.textContent).toBe('This machineDaemon settings, shared by every device paired to it.');
  });

  it('says a device’s settings are stored in this browser only and never copied to a machine', async () => {
    const line = await scope(<SettingsScope scope="device" />);
    expect(line.getAttribute('data-settings-scope')).toBe('device');
    expect(line.textContent).toBe('This deviceStored in this browser only, and never copied to another machine.');
  });
});

describe('SettingsPage scope lines', () => {
  it('marks Appearance and Behaviour as this device’s, under the section header', async () => {
    for (const hash of ['#appearance', '#behaviour']) {
      window.history.replaceState({}, '', `/d/daemon-alpha/settings${hash}`);
      const view = await mount(page());
      const header = must(view.container.querySelector<HTMLElement>('[data-settings-section] header'), 'the header');
      expect(header.querySelector('[data-settings-scope="device"]')?.textContent).toContain('This device');
      expect(view.container.querySelector('[data-settings-scope="machine"]')).toBeNull();
      await view.unmount();
    }
  });

  it('marks the Machines section as the routed machine’s, by name, above its surface', async () => {
    window.history.replaceState({}, '', `/d/daemon-alpha/settings${ALPHA_MACHINE}`);
    const view = await mount(panelsPage());
    await settle();
    const line = must(view.container.querySelector<HTMLElement>('[data-settings-scope="machine"]'), 'the machine line');
    expect(line.textContent).toContain('Alpha workstation’s daemon settings, shared by every device paired to it.');
    expect(view.container.querySelector('[data-settings-scope="device"]')).toBeNull();
    const surface = must(view.container.querySelector('[data-daemon-panel="warden"]'), 'the panels');
    expect(line.compareDocumentPosition(surface) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
    await view.unmount();
  });

  it('says it without a name when the routed daemon is not paired here', async () => {
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#machines');
    const view = await mount(panelsPage({ current: alpha, connections: [beta] }));
    await settle();
    expect(view.container.querySelector('[data-settings-scope="machine"]')?.textContent).toContain(
      'Daemon settings, shared by every device paired to it.',
    );
    await view.unmount();
  });
});

describe('SettingsPage legacy Daemons addresses', () => {
  it('rewrites #daemons in place to this machine’s Machine tab', async () => {
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#daemons');
    const length = window.history.length;
    const view = await mount(panelsPage());
    await settle();

    expect(window.location.hash).toBe(ALPHA_MACHINE);
    // Replaced, never pushed: Back must not return to the address that no longer exists.
    expect(window.history.length).toBe(length);
    expect(shownSection(view.container)).toBe('machines');
    expect(view.container.querySelector('[data-machine-tab="machine"]')?.getAttribute('aria-current')).toBe('page');
    expect(view.container.querySelector('[data-daemon-panel="warden"]')).not.toBeNull();
    await view.unmount();
  });

  it.each([
    'warden',
    'secrets',
    'devices',
    'grants',
    'security',
    'resource-limits',
    'doctor',
    'model-pricing',
    'security-log',
    'carrier',
    'host-checks',
    'files',
    'speedups',
    'learning',
    'clone',
    'export',
  ])('rewrites the old #%s panel anchor to that panel on the Machine tab', async panel => {
    const view = await mount(panelsPage());
    await visit(`#${panel}`);
    expect(window.location.hash).toBe(`${ALPHA_MACHINE}/${panel}`);
    expect(shownSection(view.container)).toBe('machines');
    await view.unmount();
  });

  it('opens the panel a rewritten anchor names', async () => {
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#carrier');
    const view = await mount(panelsPage());
    await settle();
    expect(view.container.querySelector('[data-daemon-panel-open]')?.getAttribute('data-daemon-panel-open')).toBe(
      'carrier',
    );
    expect(view.container.querySelector('[data-active-carrier]')).not.toBeNull();
    await view.unmount();
  });

  it('leaves a legacy anchor alone when the routed daemon is not paired, since there is no machine to name', async () => {
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#daemons');
    const view = await mount(page({ current: alpha, connections: [beta] }));
    expect(window.location.hash).toBe('#daemons');
    expect(view.container.querySelector('main')?.getAttribute('data-settings-at-home')).toBe('true');
    await view.unmount();
  });
});

describe('SettingsPage machine navigation', () => {
  it('lists every paired machine by its distinct name, marking the routed one only on Machines', async () => {
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#machines/Alpha%20workstation/runtimes');
    const view = await mount(page({ connections: [alpha, beta], createMachineClient: answering }));
    await settle();
    const rows = [...sidebar(view.container).querySelectorAll<HTMLButtonElement>('[data-settings-machine]')];

    expect(rows.map(row => row.getAttribute('data-settings-machine'))).toEqual(['daemon-alpha', 'daemon-beta']);
    expect(rows.map(row => row.getAttribute('aria-current'))).toEqual(['page', null]);
    expect(rows[0]?.textContent).toContain('Alpha workstation');
    // An unnamed pairing is listed by its address, never by its fingerprint or its credential.
    expect(rows[1]?.textContent).toContain('https://beta.example.test');
    expect(rows[1]?.textContent).not.toContain('daemon-beta');
    expect(view.container.textContent).not.toContain('alpha-secret');
    expect(view.container.textContent).not.toContain('beta-secret');
    expect(sidebar(view.container).querySelector('[data-settings-section-choice][aria-current="page"]')).toBeNull();

    // On a browser section no machine is "the page".
    await visit('#appearance');
    expect(sidebar(view.container).querySelector('[data-settings-machine][aria-current="page"]')).toBeNull();
    await view.unmount();
  });

  it('lists the machines in this device\u2019s saved order, a machine it has never seen last', async () => {
    const controls = new DaemonControlsStore(memoryStorage());
    controls.setDeviceControls({ machineOrder: ['daemon-beta', 'daemon-gone'] });
    const gamma = daemon('daemon-gamma', 'https://gamma.example.test', 'gamma-secret', 'Gamma');
    const view = await mount(page({ connections: [alpha, gamma, beta], controls, createMachineClient: answering }));
    await settle();
    const rows = [...sidebar(view.container).querySelectorAll('[data-settings-machine]')];
    expect(rows.map(row => row.getAttribute('data-settings-machine'))).toEqual([
      'daemon-beta',
      'daemon-alpha',
      'daemon-gamma',
    ]);
    await view.unmount();
  });

  it('says under each machine whether it answers, read once for the whole page', async () => {
    const asked: string[] = [];
    const reach: FleetClientFactory = async connection => {
      asked.push(String(connection.daemonId));
      if (connection.daemonId === beta.daemonId) throw new Error('offline');
      return machineClient(machineView({ name: 'alpha-host', runtimeCount: 2 }));
    };
    const gamma = daemon('daemon-gamma', 'https://gamma.example.test', 'gamma-secret', 'Gamma');
    const view = await mount(
      page({ connections: [beta, alpha, gamma], createMachineClient: reach, lockedMachines: [gamma.daemonId] }),
    );
    await settle();
    const summary = (id: string): string | null | undefined =>
      sidebar(view.container).querySelector(`[data-settings-machine="${id}"] .kt-navpill__sub`)?.textContent;

    // The page's own machine first, because its tabs are waiting on the answer.
    expect(asked[0]).toBe('daemon-alpha');
    expect(summary('daemon-alpha')).toBe('Online · 2 runtimes');
    expect(summary('daemon-beta')).toBe('Offline');
    expect(summary('daemon-gamma')).toBe('Locked · Open it to unlock');
    await view.unmount();
  });

  it('says every machine is checking while there is no way to ask one', async () => {
    const view = await mount(page({ connections: [alpha, beta] }));
    for (const id of ['daemon-alpha', 'daemon-beta'])
      expect(
        sidebar(view.container).querySelector(`[data-settings-machine="${id}"] .kt-navpill__sub`)?.textContent,
      ).toBe('Checking');
    await view.unmount();
  });

  it('opens a machine from the sidebar on its default tab, and Add a machine opens pairing', async () => {
    const callbacks = calls();
    const view = await mount(page({ connections: [alpha, beta], calls: callbacks }));
    await interact(() =>
      must(
        sidebar(view.container).querySelector<HTMLButtonElement>('[data-settings-machine="daemon-alpha"]'),
        'Alpha',
      ).click(),
    );
    await interact(() =>
      must(sidebar(view.container).querySelector<HTMLButtonElement>('[data-machine-add]'), 'Add a machine').click(),
    );
    expect(callbacks.navigated).toEqual(['/d/daemon-alpha/settings#machines/Alpha%20workstation/runtimes']);
    expect(callbacks.added).toEqual(['add']);
    await view.unmount();
  });
});

describe('SettingsPage controls', () => {
  it('keeps controls at the touch-target floor and persists density only as a device preference', () => {
    const controls = new DaemonControlsStore(memoryStorage());
    const view = render(page({ controls }));
    const compact = view.root
      .findAllByType('input')
      .find(input => input.props.name === 'dashboard-density' && input.props.value === 'compact');

    for (const control of view.root.findAll(
      node => typeof node.props.className === 'string' && node.props.className.includes('min-h-[44px]'),
    ))
      expect(control.props.className).toContain('min-h-[44px]');

    run(() => compact?.props.onChange());
    expect(controls.snapshot().device.density).toBe('compact');
    expect(controls.snapshot().scopes).toEqual(Object.create(null));
    run(() => view.unmount());
  });

  it('leaves text-scale choices visible but disabled when percentage adjustment is unsupported', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'CSS');
    Object.defineProperty(globalThis, 'CSS', { configurable: true, value: { supports: () => false } });
    try {
      const view = render(page());
      expect(view.root.findByProps({ id: 'text-scale-unsupported' }).props.role).toBe('status');
      for (const input of view.root.findAllByType('input').filter(input => input.props.name === 'text-scale'))
        expect(input.props.disabled).toBe(true);
      run(() => view.unmount());
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'CSS', descriptor);
      else Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'CSS');
    }
  });
});

/**
 * The paired daemon's own panels, which used to be the Daemons section. They live on each machine's
 * Machine tab now; the page's part is to hand that tab the ROUTED daemon's frame and pairing record.
 */
describe('SettingsPage daemon panels on the Machine tab', () => {
  it('lists the routed daemon’s panels, and opens one by moving the address', async () => {
    window.history.replaceState({}, '', `/d/daemon-alpha/settings${ALPHA_MACHINE}`);
    const view = await mount(panelsPage({ connections: [alpha, beta] }));
    await settle();
    const frame = must(view.container.querySelector<HTMLElement>('[data-daemon-settings-frame]'), 'the frame');

    expect(frame.getAttribute('data-daemon-settings-frame')).toBe('daemon-alpha');
    expect(
      [...frame.querySelectorAll('[data-daemon-panel]')].map(row => row.getAttribute('data-daemon-panel')),
    ).toEqual(['warden', 'secrets', 'devices', 'grants', 'security', 'carrier', 'host-checks']);

    await interact(() =>
      must(frame.querySelector<HTMLButtonElement>('[data-daemon-panel="carrier"]'), 'Carrier').click(),
    );
    expect(window.location.hash).toBe(`${ALPHA_MACHINE}/carrier`);
    expect(view.container.querySelector('[data-active-carrier]')).not.toBeNull();

    // Back from an open panel is the list again, on the same machine.
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-daemon-panel-back]'), 'the panel back').click(),
    );
    expect(window.location.hash).toBe(ALPHA_MACHINE);
    expect(view.container.querySelector('[data-active-carrier]')).toBeNull();
    await view.unmount();
  });

  it('mounts the same daemon’s Secrets panel when the address names it', async () => {
    // The panel is the only way the secret surface is reachable, so one that renders nothing is a
    // capability the product does not have.
    const current = daemon('daemon beta', 'https://beta.example.test', 'secret');
    window.history.replaceState(
      {},
      '',
      '/d/daemon%20beta/settings#machines/https%3A%2F%2Fbeta.example.test/machine/secrets',
    );
    const view = await mount(panelsPage({ current, connections: [current] }));
    await settle();

    expect(
      view.container.querySelector('[data-daemon-settings-frame]')?.getAttribute('data-daemon-settings-frame'),
    ).toBe('daemon beta');
    expect(view.container.querySelector('[data-daemon-panel-open]')?.getAttribute('data-daemon-panel-open')).toBe(
      'secrets',
    );
    // Without a client the surface states that it could not read, which is exactly what it must do
    // rather than rendering an empty store.
    expect(
      view.container.querySelectorAll('[aria-label="Loading secrets"], [aria-label="Secrets unavailable"]').length,
    ).toBeGreaterThan(0);
    await view.unmount();
  });

  /**
   * The panel a refused control sends somebody to. A panel that renders nothing is a capability the
   * product does not have, and this is the panel that explains every other panel's refusals.
   */
  it('mounts the same daemon’s capability-limits panel when the address names it', async () => {
    window.history.replaceState({}, '', `/d/daemon-alpha/settings${ALPHA_MACHINE}/grants`);
    const view = await mount(panelsPage());
    await settle();

    // With no client supplied the surface says it is reading or that it could not — never five allowed
    // rows, which over an unread daemon is the opposite of the truth.
    expect(
      view.container.querySelectorAll(
        '[aria-label="Loading capability grants"], [aria-label="Capability grants unavailable"]',
      ).length,
    ).toBeGreaterThan(0);
    await view.unmount();
  });

  it('keeps Carrier and host controls inside the routed daemon’s frame', async () => {
    window.history.replaceState({}, '', `/d/daemon-alpha/settings${ALPHA_MACHINE}`);
    const view = await mount(panelsPage());
    await settle();

    expect(view.container.querySelector('[data-active-carrier]')).toBeNull();
    await visit(`${ALPHA_MACHINE}/carrier`);
    expect(
      view.container.querySelectorAll('[data-daemon-settings-frame="daemon-alpha"] [data-active-carrier]'),
    ).toHaveLength(1);
    await visit(`${ALPHA_MACHINE}/host-checks`);
    expect(hostChecks(view.container, 'daemon-alpha')).toBeDefined();
    await view.unmount();
  });

  it('keeps rename and removal behind the row disclosure and targets only that daemon', async () => {
    window.history.replaceState({}, '', `/d/daemon-alpha/settings${ALPHA_MACHINE}/host-checks`);
    const callbacks = calls();
    const view = await mount(panelsPage({ connections: [alpha, beta], calls: callbacks }));
    await settle();
    const alphaHostChecks = hostChecks(view.container, 'daemon-alpha');
    const details = must(
      [...alphaHostChecks.querySelectorAll<HTMLDetailsElement>('details')].find(
        candidate => candidate.querySelector('summary')?.textContent === 'Manage daemon',
      ),
      'daemon management disclosure',
    );

    expect(details.open).toBe(false);
    expect(callbacks.removed).toEqual([]);
    await interact(() => must(details.querySelector<HTMLElement>('summary'), 'Manage daemon').click());
    expect(details.open).toBe(true);
    expect(details.textContent).toContain('only forgets it in this browser');
    expect(details.textContent).toContain('https://alpha.example.test');

    const input = must(details.querySelector<HTMLInputElement>('input'), 'display name');
    const form = must(input.closest('form'), 'rename form');
    await writeInput(input, '  Alpha lab  ');
    await interact(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(callbacks.renamed).toEqual([{ id: 'daemon-alpha', label: 'Alpha lab' }]);

    await writeInput(input, '');
    await interact(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(callbacks.renamed.at(-1)).toEqual({ id: 'daemon-alpha', label: undefined });

    await interact(() =>
      must(details.querySelector<HTMLButtonElement>('[data-remove-daemon="daemon-alpha"]'), 'remove pairing').click(),
    );
    expect(callbacks.removed).toEqual(['daemon-alpha']);
    await view.unmount();
  });

  it('validates display names without issuing a stale rename', async () => {
    window.history.replaceState({}, '', `/d/daemon-alpha/settings${ALPHA_MACHINE}/host-checks`);
    const callbacks = calls();
    const view = await mount(panelsPage({ calls: callbacks }));
    await settle();
    const input = must(
      hostChecks(view.container, 'daemon-alpha').querySelector<HTMLInputElement>('input'),
      'display name',
    );
    const form = must(input.closest('form'), 'rename form');

    await writeInput(input, 'x'.repeat(65));
    expect(hostChecks(view.container, 'daemon-alpha').querySelector('[role="alert"]')?.textContent).toContain(
      '64 characters or fewer',
    );
    await interact(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(callbacks.renamed).toEqual([]);

    await writeInput(input, 'bad\u0007name');
    expect(hostChecks(view.container, 'daemon-alpha').querySelector('[role="alert"]')?.textContent).toContain(
      'control or formatting characters',
    );
    await view.unmount();
  });

  it('fails closed while probing, then distinguishes a valid response from a rejection', async () => {
    window.history.replaceState({}, '', `/d/daemon-alpha/settings${ALPHA_MACHINE}/host-checks`);
    const alphaHealth = deferred<unknown>();
    const probed: string[] = [];
    const probe: DaemonReachabilityProbe = connection => {
      probed.push(`${connection.daemonId}:${connection.deviceId}`);
      return alphaHealth.promise;
    };
    const view = await mount(panelsPage({ connections: [alpha, beta], probe }));

    expect(probed).toEqual(['daemon-alpha:alpha-secret']);
    expect(reachability(view.container, 'daemon-alpha')).toBe('checking');
    expect(view.container.querySelector('[data-daemon-reachability="reachable"]')).toBeNull();

    alphaHealth.resolve({ ok: false });
    await settle();

    // A schema-valid health response proves reachability; its own `ok` flag is
    // daemon health, not network reachability.
    expect(reachability(view.container, 'daemon-alpha')).toBe('reachable');
    await view.unmount();
  });

  /**
   * The screenshot that started this: a green `Reachable` pill beside a Carrier
   * panel saying no configured connection worked. Both were reporting honestly,
   * which is what made it so bad — the probe took the typed client's own direct
   * transport and the carrier took the router, so the two things on one screen that
   * answer "can this browser reach that daemon" answered it over different code.
   *
   * The mechanism is fixed in the composition root. This is the freshness half: a
   * live carrier refusal outranks a poll that may be most of a minute old.
   */
  it('never shows a daemon as reachable while its carrier says nothing worked', async () => {
    window.history.replaceState({}, '', `/d/daemon-alpha/settings${ALPHA_MACHINE}/host-checks`);
    const health = deferred<unknown>();
    const controls = new DaemonControlsStore(memoryStorage());
    const view = await mount(panelsPage({ connections: [alpha, beta], controls, probe: () => health.promise }));

    health.resolve({});
    await settle();
    expect(reachability(view.container, 'daemon-alpha')).toBe('reachable');

    const refused: ConnectionChoice = {
      ok: false,
      reason: 'No configured connection worked: direct was not reachable (Failed to fetch).',
      passedOver: [{ method: { kind: 'direct', daemonUrl: 'https://alpha.example.test' }, detail: 'Failed to fetch' }],
    };
    await view.render(
      panelsPage({ connections: [alpha, beta], controls, probe: () => health.promise, carrier: refused }),
    );
    await settle();
    await visit(`${ALPHA_MACHINE}/carrier`);
    expect(view.container.textContent).toContain('No configured connection worked');
    await visit(`${ALPHA_MACHINE}/host-checks`);

    expect(reachability(view.container, 'daemon-alpha')).toBe('unreachable');
    // A machine's status is mounted only inside its own open panel. There is no
    // second daemon row here that could borrow alpha's carrier result.
    expect(view.container.querySelector('[data-daemon-host-checks="daemon-beta"]')).toBeNull();
    await view.unmount();
  });

  it('lets a carrier that has carried something leave the probe alone', async () => {
    window.history.replaceState({}, '', `/d/daemon-alpha/settings${ALPHA_MACHINE}/host-checks`);
    const health = deferred<unknown>();
    const carried: ConnectionChoice = {
      ok: true,
      method: { kind: 'direct', daemonUrl: 'https://alpha.example.test' },
      reason: 'Connected over direct.',
      passedOver: [],
    };
    const view = await mount(panelsPage({ probe: () => health.promise, carrier: carried }));

    // A carrier that worked is not permission to skip the probe: this badge is about
    // the daemon answering, and it says `checking` until one does.
    expect(reachability(view.container, 'daemon-alpha')).toBe('checking');
    health.resolve({});
    await settle();
    expect(reachability(view.container, 'daemon-alpha')).toBe('reachable');
    await view.unmount();
  });

  it('resets and fences health when the same daemon is re-paired with a rotated credential', async () => {
    window.history.replaceState({}, '', `/d/daemon-alpha/settings${ALPHA_MACHINE}/host-checks`);
    const oldHealth = deferred<unknown>();
    const newHealth = deferred<unknown>();
    const rotated = daemon('daemon-alpha', 'https://alpha.example.test', 'alpha-rotated', 'Alpha workstation');
    const probe: DaemonReachabilityProbe = connection =>
      connection.deviceId === 'alpha-secret' ? oldHealth.promise : newHealth.promise;
    const controls = new DaemonControlsStore(memoryStorage());
    const view = await mount(panelsPage({ current: alpha, connections: [alpha], controls, probe }));

    oldHealth.resolve({});
    await settle();
    expect(reachability(view.container, 'daemon-alpha')).toBe('reachable');

    await view.render(panelsPage({ current: rotated, connections: [rotated], controls, probe }));
    expect(reachability(view.container, 'daemon-alpha')).toBe('checking');

    // This is a second old-pairing request kept pending across the re-pair. Its
    // answer cannot paint the rotated grant green.
    const stale = deferred<unknown>();
    const fresh = deferred<unknown>();
    const lateProbe: DaemonReachabilityProbe = connection =>
      connection.deviceId === 'alpha-secret' ? stale.promise : fresh.promise;
    await view.render(panelsPage({ current: alpha, connections: [alpha], controls, probe: lateProbe }));
    await view.render(panelsPage({ current: rotated, connections: [rotated], controls, probe: lateProbe }));
    stale.resolve({});
    await settle();
    expect(reachability(view.container, 'daemon-alpha')).toBe('checking');

    fresh.resolve({});
    await settle();
    expect(reachability(view.container, 'daemon-alpha')).toBe('reachable');
    newHealth.resolve({});
    await view.unmount();
  });

  it('fails closed before a rotated pairing can publish new health evidence', async () => {
    const rotated = daemon('daemon-alpha', 'https://alpha.example.test', 'alpha-rotated', 'Alpha workstation');
    const RepairedHostChecks = () => {
      const [connection, setConnection] = useState<DaemonConnectionRecord>(alpha);
      useLayoutEffect(() => setConnection(rotated), []);
      return (
        <DaemonHostChecks
          connection={connection}
          probeDaemon={pendingProbe}
          onRenameDaemon={() => {}}
          onRemoveDaemon={() => {}}
        />
      );
    };

    const view = await mount(<RepairedHostChecks />);

    expect(reachability(view.container, 'daemon-alpha')).toBe('checking');
    await view.unmount();
  });

  it('runs a manual reachability retry against the exact row', async () => {
    window.history.replaceState({}, '', `/d/daemon-alpha/settings${ALPHA_MACHINE}/host-checks`);
    const attempts = [deferred<unknown>(), deferred<unknown>()];
    let reads = 0;
    const view = await mount(panelsPage({ probe: () => must(attempts[reads++]?.promise, 'probe attempt') }));
    attempts[0]?.resolve({});
    await settle();
    expect(reachability(view.container, 'daemon-alpha')).toBe('reachable');

    await interact(() =>
      must(
        view.container.querySelector<HTMLButtonElement>('[aria-label="Check Alpha workstation reachability again"]'),
        'reachability retry',
      ).click(),
    );
    expect(reachability(view.container, 'daemon-alpha')).toBe('checking');
    attempts[1]?.reject(new Error('offline'));
    await settle();
    expect(reachability(view.container, 'daemon-alpha')).toBe('unreachable');
    expect(reads).toBe(2);
    await view.unmount();
  });

  it('names the machine in its header without promoting the fingerprint', async () => {
    window.history.replaceState({}, '', `/d/daemon-alpha/settings${ALPHA_MACHINE}/host-checks`);
    const view = await mount(panelsPage({ connections: [alpha, beta] }));
    await settle();
    const header = must(view.container.querySelector<HTMLElement>('[data-machine-header]'), 'the machine header');

    expect(header.querySelector('#settings-machine-heading')?.textContent).toBe('Alpha workstation');
    // The fingerprint belongs to Host checks' technical-identity disclosure.
    expect(header.textContent).not.toContain('daemon-alpha');

    const disclosure = must(
      [...hostChecks(view.container, 'daemon-alpha').querySelectorAll<HTMLDetailsElement>('details')].find(
        candidate => candidate.querySelector('summary')?.textContent === 'Technical identity',
      ),
      'the technical identity disclosure',
    );
    expect(disclosure.open).toBe(false);
    expect(disclosure.textContent).toContain('daemon-alpha');
    await view.unmount();
  });

  it('shows an unnamed daemon’s address once, as the name, and never twice', async () => {
    window.history.replaceState({}, '', '/d/daemon-beta/settings#machines/https%3A%2F%2Fbeta.example.test/machine');
    const view = await mount(panelsPage({ current: beta, connections: [beta] }));
    await settle();
    const header = must(view.container.querySelector<HTMLElement>('[data-machine-header]'), 'the machine header');

    expect(header.textContent?.match(/https:\/\/beta\.example\.test/g)).toHaveLength(1);
    await view.unmount();
  });

  it('remounts the panels for the newly routed daemon instead of leaking the other daemon’s panel', async () => {
    window.history.replaceState({}, '', `/d/daemon-alpha/settings${ALPHA_MACHINE}`);
    const controls = new DaemonControlsStore(memoryStorage());
    const view = await mount(panelsPage({ current: alpha, connections: [alpha], controls }));
    await settle();
    expect(
      view.container.querySelector('[data-daemon-settings-frame]')?.getAttribute('data-daemon-settings-frame'),
    ).toBe('daemon-alpha');

    window.history.replaceState({}, '', '/d/daemon-beta/settings#machines/https%3A%2F%2Fbeta.example.test/machine');
    await view.render(panelsPage({ current: beta, connections: [beta], controls }));
    await settle();
    expect(view.container.querySelectorAll('[data-daemon-settings-frame]')).toHaveLength(1);
    expect(
      view.container.querySelector('[data-daemon-settings-frame]')?.getAttribute('data-daemon-settings-frame'),
    ).toBe('daemon-beta');
    await view.unmount();
  });

  it('draws no panels at all when the routed daemon is absent from the registry, and says so', async () => {
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#machines');
    const view = await mount(panelsPage({ current: alpha, connections: [beta] }));
    await settle();

    // An empty list beside a warning reads as an empty state; the damaged state has to replace the
    // whole frame — and showing beta's settings under alpha's route would be the wrong daemon.
    expect(view.container.querySelector('[data-daemon-settings-frame]')).toBeNull();
    expect(view.container.querySelector('[data-settings-section="machines"] [role="alert"]')?.textContent).toBe(
      'This machine is not paired with this browser, so its setup cannot be shown.',
    );
    expect(view.container.querySelector('#settings-section-panel')?.textContent).not.toContain('Alpha workstation');
    await view.unmount();
  });
});

describe('SettingsPage Machines section', () => {
  const machines: FleetClientFactory = answering;
  const labelledBeta = { ...beta, label: 'Beta box' };

  const machinesSurface = (container: HTMLElement): HTMLElement | null =>
    container.querySelector<HTMLElement>('[data-machines-surface]');

  it('opens from a Machines link on the named tab, and follows a later link', async () => {
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#machines/Alpha%20workstation/profiles');
    const callbacks = calls();
    const view = await mount(
      page({ connections: [alpha, labelledBeta], createMachineClient: machines, calls: callbacks }),
    );
    await settle();
    expect(shownSection(view.container)).toBe('machines');
    expect(view.container.querySelector('#settings-section-panel')?.getAttribute('aria-labelledby')).toBe(
      'settings-machine-heading',
    );
    expect(machinesSurface(view.container)?.getAttribute('data-machines-surface')).toBe('daemon-alpha');
    expect(view.container.querySelector('[data-machine-tab="profiles"]')?.getAttribute('aria-current')).toBe('page');
    expect(view.container.querySelector('[data-machine-unknown]')).toBeNull();

    await visit('#machines/Alpha%20workstation/components');
    expect(view.container.querySelector('[data-machine-tab="components"]')?.getAttribute('aria-current')).toBe('page');

    // A tab is an address: the page navigates to it rather than holding it as private state.
    await interact(() =>
      must(view.container.querySelector<HTMLElement>('[data-machine-tab="credentials"]'), 'credentials tab').click(),
    );
    expect(callbacks.navigated).toEqual(['/d/daemon-alpha/settings#machines/Alpha%20workstation/credentials']);
    await view.unmount();
  });

  it('a link naming another paired machine goes to THAT daemon’s Settings, never shows it here', async () => {
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#machines/Beta%20box/runtimes');
    const callbacks = calls();
    const view = await mount(
      page({ connections: [alpha, labelledBeta], createMachineClient: machines, calls: callbacks }),
    );
    await settle();
    expect(callbacks.navigated).toEqual(['/d/daemon-beta/settings#machines/Beta%20box/runtimes']);
    await view.unmount();
  });

  it('passes the name a machine answers with up to the page, so an older pairing learns it', async () => {
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#machines/Alpha%20workstation/runtimes');
    const callbacks = { ...calls(), named: [] as string[] };
    const view = await mount(page({ connections: [alpha], createMachineClient: machines, calls: callbacks }));
    await settle();
    expect(callbacks.named).toEqual(['daemon-alpha=alpha-host']);
    await view.unmount();
  });

  it('still finds a machine a link names by its address, written before it learned its name', async () => {
    // A pairing that predates keeping the daemon's name was shown, and linked, by its address.
    window.history.replaceState(
      {},
      '',
      `/d/daemon-alpha/settings#machines/${encodeURIComponent(beta.baseUrl)}/runtimes`,
    );
    const callbacks = calls();
    const view = await mount(
      page({ connections: [alpha, labelledBeta], createMachineClient: machines, calls: callbacks }),
    );
    await settle();
    expect(callbacks.navigated).toEqual(['/d/daemon-beta/settings#machines/Beta%20box/runtimes']);
    expect(view.container.querySelector('[data-machine-unknown]')).toBeNull();
    await view.unmount();
  });

  it('a link naming a machine nobody paired says so and shows this one', async () => {
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#machines/ghost/runtimes');
    const callbacks = calls();
    const view = await mount(page({ createMachineClient: machines, calls: callbacks }));
    await settle();
    expect(view.container.querySelector('[data-machine-unknown]')?.textContent).toContain('ghost');
    expect(callbacks.navigated).toEqual([]);
    await view.unmount();
  });

  it('two pairings with one name never bounce between them', async () => {
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#machines/Alpha%20workstation/runtimes');
    const callbacks = calls();
    const twin = { ...labelledBeta, label: 'Alpha workstation' };
    const view = await mount(page({ connections: [twin, alpha], createMachineClient: machines, calls: callbacks }));
    await settle();
    expect(callbacks.navigated).toEqual([]);
    await view.unmount();
  });

  it('renders the supplied tab surfaces, and navigates without a router by assigning the address', async () => {
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#machines');
    const view = await mount(
      page({
        createMachineClient: machines,
        routerless: true,
        machineTabs: { runtimes: ({ machineName }) => <p data-runtimes-tab="">{machineName}</p> },
      }),
    );
    await settle();
    expect(view.container.querySelector('[data-runtimes-tab]')?.textContent).toBe('Alpha workstation');
    await interact(() =>
      must(view.container.querySelector<HTMLElement>('[data-machine-tab="machine"]'), 'Machine tab').click(),
    );
    expect(window.location.hash).toBe('#machines/Alpha%20workstation/machine');
    await view.unmount();
  });

  it('never opens the first run by itself: a machine that is not set up offers it, on a screen of its own', async () => {
    const fresh: FleetClientFactory = async () =>
      machineClient(machineView({ name: 'alpha-host', setUp: false, runtimeCount: 0 }));
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#machines/Alpha%20workstation/runtimes');
    const callbacks = calls();
    const view = await mount(page({ createMachineClient: fresh, calls: callbacks }));
    await settle();

    // The address is left where the reader put it.
    expect(window.location.hash).toBe('#machines/Alpha%20workstation/runtimes');
    expect(callbacks.navigated).toEqual([]);
    await interact(() =>
      must(
        view.container.querySelector<HTMLButtonElement>('[data-machine-finish-setup-open]'),
        'Finish setting up',
      ).click(),
    );
    expect(callbacks.navigated).toEqual(['/d/daemon-alpha/setup']);
    await view.unmount();
  });

  it('opens the full-screen setup on the step a tab names: Import again lands on Claude Code', async () => {
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#machines/Alpha%20workstation/machine');
    const callbacks = calls();
    const view = await mount(
      page({
        createMachineClient: answering,
        calls: callbacks,
        machineTabs: {
          machine: ({ onSetUp }) => (
            <div>
              <button type="button" data-open-setup="" onClick={() => onSetUp?.()} />
              <button type="button" data-open-import="" onClick={() => onSetUp?.('claude')} />
            </div>
          ),
        },
      }),
    );
    await settle();
    await interact(() => must(view.container.querySelector<HTMLElement>('[data-open-setup]'), 'setup').click());
    await interact(() => must(view.container.querySelector<HTMLElement>('[data-open-import]'), 'import').click());
    expect(callbacks.navigated).toEqual(['/d/daemon-alpha/setup', '/d/daemon-alpha/setup#claude']);
    await view.unmount();
  });

  it('asks the open machine again when the reader says Check again', async () => {
    let reads = 0;
    const flaky: FleetClientFactory = async () => {
      reads += 1;
      if (reads === 1) throw new Error('asleep');
      return machineClient(machineView({ name: 'alpha-host' }));
    };
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#machines/Alpha%20workstation/runtimes');
    const view = await mount(page({ createMachineClient: flaky }));
    await settle();
    expect(view.container.querySelector('[data-machine-status]')?.getAttribute('data-machine-status')).toBe('offline');

    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-machine-retry]'), 'Check again').click(),
    );
    await settle();
    expect(reads).toBe(2);
    expect(view.container.querySelector('[data-machine-status]')?.getAttribute('data-machine-status')).toBe('online');
    await view.unmount();
  });

  it('says it cannot show machines when the page has no way to reach them', async () => {
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#machines');
    const view = await mount(page());
    expect(machinesSurface(view.container)).toBeNull();
    expect(view.container.querySelector('[data-settings-section="machines"] [role="alert"]')?.textContent).toBe(
      'Machines cannot be shown because this page was opened without a way to reach them.',
    );
    await view.unmount();
  });
});
