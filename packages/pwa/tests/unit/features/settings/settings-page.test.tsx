import type { ConnectionChoice } from '@ferretry/relay';
import { beforeEach, describe, expect, it } from 'bun:test';
import { useLayoutEffect, useState } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';

import { DaemonHostChecks, type DaemonReachabilityProbe } from '../../../../src/features/settings/daemon-settings.tsx';
import { SettingsPage } from '../../../../src/features/settings/settings-page.tsx';
import type { WardenClientFactory } from '../../../../src/features/warden/warden-config-card.tsx';
import type { DaemonConnectionRecord } from '../../../../src/lib/connections.ts';
import { type ControlsStorage, DaemonControlsStore } from '../../../../src/lib/controls.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { DEFAULT_STT_SETTINGS } from '../../../../src/lib/stt/stt-settings.ts';
import { UNSUPPORTED_RECOGNITION } from '../../../support/browser-recognition.ts';
import { interact, mount, must } from '../../../support/dom.ts';
import { render, run } from '../../../support/react.ts';

const memoryStorage = (): ControlsStorage => {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

const pendingProbe: DaemonReachabilityProbe = () => new Promise(() => undefined);
const unavailableWardenClient: WardenClientFactory = async () =>
  Promise.reject(new Error('Warden unavailable in this test.'));

const daemon = (id: string, baseUrl: string, deviceToken: string, label?: string): DaemonConnectionRecord => ({
  ...daemonConnection({ daemonId: id, baseUrl, deviceToken }),
  ...(label === undefined ? {} : { label }),
  pairedAt: 1,
  lastSelectedAt: 2,
});

const alpha = daemon('daemon-alpha', 'https://alpha.example.test', 'alpha-secret', 'Alpha workstation');
const beta = daemon('daemon-beta', 'https://beta.example.test', 'beta-secret');

interface Callbacks {
  readonly selected: string[];
  readonly renamed: Array<{ id: string; label: string | undefined }>;
  readonly removed: string[];
  readonly added: string[];
  readonly navigated: string[];
}

const calls = (): Callbacks => ({ selected: [], renamed: [], removed: [], added: [], navigated: [] });

interface PageOptions {
  readonly current?: DaemonConnectionRecord;
  readonly connections?: readonly DaemonConnectionRecord[];
  readonly controls?: DaemonControlsStore;
  readonly probe?: DaemonReachabilityProbe;
  readonly carrier?: ConnectionChoice;
  readonly calls?: Callbacks;
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
      onSelectDaemon={id => callbacks.selected.push(id)}
      onRenameDaemon={(id, label) => callbacks.renamed.push({ id, label })}
      onRemoveDaemon={id => callbacks.removed.push(id)}
      onAddDaemon={() => callbacks.added.push('add')}
      onNavigate={to => callbacks.navigated.push(to)}
    />
  );
};

const settingIds = (view: ReactTestRenderer): string[] =>
  view.root
    .findAll(node => node.props['data-setting-id'] !== undefined)
    .map(section => String(section.props['data-setting-id']));

const selectDesktopSection = (view: ReactTestRenderer, section: string): void => {
  run(() => view.root.findByProps({ 'data-settings-section-choice': section }).props.onClick());
};

const daemonSubtab = (container: HTMLElement, id: string): HTMLButtonElement =>
  must(container.querySelector<HTMLButtonElement>(`[data-daemon-subtab="${id}"]`), `${id} daemon sub-tab`);

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
});

describe('SettingsPage sections', () => {
  it('owns one scroll region and starts with the four Appearance settings in stable order', () => {
    const view = render(page());
    const scroller = view.root.findByProps({ 'data-settings-scroller': true });
    const tabs = view.root.findAll(node => node.props['data-settings-section-choice'] !== undefined);

    expect(scroller.props.className).toContain('overflow-y-auto');
    expect(tabs.map(tab => tab.findAllByType('span')[1]?.children.join(''))).toEqual([
      'Appearance',
      'Behaviour',
      'Daemons',
    ]);
    expect(tabs.map(tab => tab.props['aria-current'])).toEqual(['page', undefined, undefined]);
    expect(settingIds(view)).toEqual(['text-size', 'theme', 'density', 'chat-width']);
    expect(view.root.findByProps({ 'data-settings-section': 'appearance' }).props.id).toBe('settings-section-panel');

    run(() => view.unmount());
  });

  it('switches one panel between Behaviour and Daemons without rendering controls from another section', () => {
    const view = render(page({ connections: [alpha, beta] }));

    selectDesktopSection(view, 'behaviour');
    expect(settingIds(view)).toEqual(['composer-markdown', 'composer-enter-key', 'dictation', 'notifications']);
    expect(view.root.findAllByProps({ 'data-settings-section': 'appearance' })).toHaveLength(0);
    expect(view.root.findByProps({ 'data-settings-section': 'behaviour' }).props.id).toBe('settings-section-panel');

    selectDesktopSection(view, 'daemons');
    expect(settingIds(view)).toEqual([]);
    expect(view.root.findByProps({ 'aria-label': 'Connected daemons' })).toBeDefined();
    expect(view.root.findAllByProps({ 'data-settings-section': 'behaviour' })).toHaveLength(0);

    run(() => view.unmount());
  });

  it('uses the shared BottomSheet as the mobile section picker and closes it after a choice', async () => {
    const view = await mount(page());
    const trigger = must(
      view.container.querySelector<HTMLButtonElement>('[data-settings-section-trigger]'),
      'mobile section trigger',
    );
    const desktop = must(
      view.container.querySelector<HTMLElement>('nav[aria-label="Settings sections"]'),
      'desktop nav',
    );

    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.className).toContain('min-h-[52px]');
    expect(trigger.parentElement?.className).toContain('md:hidden');
    expect(desktop.className).toContain('hidden');
    expect(desktop.className).toContain('md:block');
    expect(view.container.querySelector('[data-bottom-sheet]')).toBeNull();

    await interact(() => trigger.click());
    const dialog = must(view.container.querySelector<HTMLElement>('#settings-section-picker'), 'section picker dialog');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(view.container.querySelector('[data-bottom-sheet="settings-section-picker"]')).not.toBeNull();
    expect(view.container.querySelector('[data-sheet-swipe="supported"]')).not.toBeNull();

    await interact(() =>
      must(
        dialog.querySelector<HTMLButtonElement>('[data-settings-section-choice="behaviour"]'),
        'mobile Behaviour choice',
      ).click(),
    );

    expect(view.container.querySelector('[data-settings-section]')?.getAttribute('data-settings-section')).toBe(
      'behaviour',
    );
    expect(trigger.textContent).toContain('Behaviour');
    expect(view.container.querySelector('[data-bottom-sheet]')?.getAttribute('aria-hidden')).toBe('true');
    await view.unmount();
  });

  it('follows setting and section hashes, while ignoring an unknown hash', async () => {
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#dictation');
    const view = await mount(page());

    expect(view.container.querySelector('[data-settings-section]')?.getAttribute('data-settings-section')).toBe(
      'behaviour',
    );

    window.history.replaceState({}, '', '/d/daemon-alpha/settings#density');
    await interact(() => window.dispatchEvent(new Event('hashchange')));
    expect(view.container.querySelector('[data-settings-section]')?.getAttribute('data-settings-section')).toBe(
      'appearance',
    );
    expect(document.activeElement?.id).toBe('settings-density');

    window.history.replaceState({}, '', '/d/daemon-alpha/settings#daemons');
    await interact(() => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(view.container.querySelector('[data-settings-section]')?.getAttribute('data-settings-section')).toBe(
      'daemons',
    );

    window.history.replaceState({}, '', '/d/daemon-alpha/settings#not-a-setting');
    await interact(() => window.dispatchEvent(new Event('hashchange')));
    expect(view.container.querySelector('[data-settings-section]')?.getAttribute('data-settings-section')).toBe(
      'daemons',
    );
    await view.unmount();
  });
});

describe('SettingsPage controls and daemon-qualified links', () => {
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

  it('keeps Back navigation on the routed daemon and mounts that daemon’s Warden frame', () => {
    const callbacks = calls();
    const current = daemon('daemon beta', 'https://beta.example.test', 'secret');
    const view = render(page({ current, connections: [current], calls: callbacks }));

    selectDesktopSection(view, 'daemons');
    const anchors = view.root.findAllByType('a');
    const back = anchors.find(anchor => anchor.props['aria-label'] === 'Back to sessions');
    const frame = view.root.findByProps({ 'data-daemon-settings-frame': 'daemon beta' });
    run(() => back?.props.onClick({ button: 0, preventDefault: () => {} }));

    expect(frame.findByProps({ role: 'tab', 'aria-selected': true }).props['aria-controls']).toBe(
      'daemon-settings-tab-warden',
    );
    expect(callbacks.navigated).toEqual(['/d/daemon%20beta']);
    run(() => view.unmount());
  });

  it('mounts the same daemon’s Secrets tab when the reader selects it', () => {
    // Arrange — the tab is the only way the secret surface is reachable, so a tab that renders
    // nothing is a capability the product does not have.
    const current = daemon('daemon beta', 'https://beta.example.test', 'secret');
    const view = render(page({ current, connections: [current], calls: calls() }));
    selectDesktopSection(view, 'daemons');
    const frame = view.root.findByProps({ 'data-daemon-settings-frame': 'daemon beta' });

    // Act
    run(() => frame.findByProps({ role: 'tab', 'aria-controls': 'daemon-settings-tab-secrets' }).props.onClick());

    // Assert — without a client the surface states that it could not read, which is exactly what it
    // must do rather than rendering an empty store.
    expect(frame.findByProps({ role: 'tab', 'aria-selected': true }).props['aria-controls']).toBe(
      'daemon-settings-tab-secrets',
    );
    expect(
      frame.findAllByProps({ 'aria-label': 'Loading secrets' }).length +
        frame.findAllByProps({ 'aria-label': 'Secrets unavailable' }).length,
    ).toBeGreaterThan(0);
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

describe('daemon settings', () => {
  it('uses named daemon sub-tabs, falls back to the address, and delegates switch and add', async () => {
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#daemons');
    const callbacks = calls();
    const view = await mount(page({ connections: [alpha, beta], calls: callbacks }));
    const alphaTab = daemonSubtab(view.container, 'daemon-alpha');
    const betaTab = daemonSubtab(view.container, 'daemon-beta');

    expect(alphaTab.getAttribute('role')).toBe('tab');
    expect(alphaTab.getAttribute('aria-selected')).toBe('true');
    expect(betaTab.getAttribute('aria-selected')).toBe('false');
    expect(alphaTab.textContent).toContain('Alpha workstation');
    expect(betaTab.textContent).toContain('https://beta.example.test');
    expect(betaTab.textContent).not.toContain('daemon-beta');
    expect(view.container.textContent).not.toContain('alpha-secret');
    expect(view.container.textContent).not.toContain('beta-secret');

    await interact(() => betaTab.click());
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-add-daemon]'), 'add daemon').click(),
    );
    expect(callbacks.selected).toEqual(['daemon-beta']);
    expect(callbacks.added).toEqual(['add']);
    await view.unmount();
  });

  it('uses the shared BottomSheet for daemon selection on a phone instead of rendering a narrow name strip', async () => {
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#daemons');
    const callbacks = calls();
    const view = await mount(page({ connections: [alpha, beta], calls: callbacks }));
    const trigger = must(
      view.container.querySelector<HTMLButtonElement>('[data-daemon-subtab-trigger]'),
      'daemon picker trigger',
    );

    expect(trigger.parentElement?.getAttribute('data-daemon-subtabs')).toBe('mobile');
    expect(view.container.querySelector('[data-bottom-sheet="daemon-subtab-picker"]')).toBeNull();
    await interact(() => trigger.click());

    const picker = must(view.container.querySelector<HTMLElement>('#daemon-subtab-picker'), 'daemon picker dialog');
    expect(picker.getAttribute('role')).toBe('dialog');
    await interact(() =>
      must(picker.querySelector<HTMLButtonElement>('[data-daemon-subtab="daemon-beta"]'), 'Beta daemon choice').click(),
    );

    expect(callbacks.selected).toEqual(['daemon-beta']);
    expect(view.container.querySelector('[data-bottom-sheet]')?.getAttribute('aria-hidden')).toBe('true');
    await view.unmount();
  });

  it('keeps Carrier and host controls inside the selected daemon frame', () => {
    const view = render(page({ connections: [alpha] }));
    selectDesktopSection(view, 'daemons');
    const frame = view.root.findByProps({ 'data-daemon-settings-frame': 'daemon-alpha' });

    expect(view.root.findAll(node => node.props['data-active-carrier'] !== undefined)).toHaveLength(0);
    run(() => frame.findByProps({ role: 'tab', 'aria-controls': 'daemon-settings-tab-carrier' }).props.onClick());
    expect(frame.findAll(node => node.props['data-active-carrier'] !== undefined)).toHaveLength(1);
    run(() => frame.findByProps({ role: 'tab', 'aria-controls': 'daemon-settings-tab-host-checks' }).props.onClick());
    expect(frame.findByProps({ 'data-daemon-host-checks': 'daemon-alpha' })).toBeDefined();
    run(() => view.unmount());
  });

  it('keeps rename and removal behind the row disclosure and targets only that daemon', async () => {
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#daemons');
    const callbacks = calls();
    const view = await mount(page({ connections: [alpha, beta], calls: callbacks }));
    await interact(() =>
      must(
        view.container.querySelector<HTMLButtonElement>('[aria-controls="daemon-settings-tab-host-checks"]'),
        'host checks tab',
      ).click(),
    );
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
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#daemons');
    const callbacks = calls();
    const view = await mount(page({ connections: [alpha], calls: callbacks }));
    await interact(() =>
      must(
        view.container.querySelector<HTMLButtonElement>('[aria-controls="daemon-settings-tab-host-checks"]'),
        'host checks tab',
      ).click(),
    );
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
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#daemons');
    const alphaHealth = deferred<unknown>();
    const probed: string[] = [];
    const probe: DaemonReachabilityProbe = connection => {
      probed.push(`${connection.daemonId}:${connection.deviceToken}`);
      return alphaHealth.promise;
    };
    const view = await mount(page({ connections: [alpha, beta], probe }));
    await interact(() =>
      must(
        view.container.querySelector<HTMLButtonElement>('[aria-controls="daemon-settings-tab-host-checks"]'),
        'host checks tab',
      ).click(),
    );

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
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#daemons');
    const health = deferred<unknown>();
    const controls = new DaemonControlsStore(memoryStorage());
    const view = await mount(page({ connections: [alpha, beta], controls, probe: () => health.promise }));
    await interact(() =>
      must(
        view.container.querySelector<HTMLButtonElement>('[aria-controls="daemon-settings-tab-host-checks"]'),
        'host checks tab',
      ).click(),
    );

    health.resolve({});
    await settle();
    expect(reachability(view.container, 'daemon-alpha')).toBe('reachable');

    const refused: ConnectionChoice = {
      ok: false,
      reason: 'No configured connection worked: direct was not reachable (Failed to fetch).',
      passedOver: [{ method: { kind: 'direct', daemonUrl: 'https://alpha.example.test' }, detail: 'Failed to fetch' }],
    };
    await view.render(page({ connections: [alpha, beta], controls, probe: () => health.promise, carrier: refused }));
    await settle();
    await interact(() =>
      must(
        view.container.querySelector<HTMLButtonElement>('[aria-controls="daemon-settings-tab-carrier"]'),
        'carrier tab',
      ).click(),
    );
    expect(view.container.textContent).toContain('No configured connection worked');
    await interact(() =>
      must(
        view.container.querySelector<HTMLButtonElement>('[aria-controls="daemon-settings-tab-host-checks"]'),
        'host checks tab',
      ).click(),
    );

    expect(reachability(view.container, 'daemon-alpha')).toBe('unreachable');
    // A machine's status is mounted only inside its own selected sub-tab. There
    // is no second daemon row here that could borrow alpha's carrier result.
    expect(view.container.querySelector('[data-daemon-host-checks="daemon-beta"]')).toBeNull();
    await view.unmount();
  });

  it('lets a carrier that has carried something leave the probe alone', async () => {
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#daemons');
    const health = deferred<unknown>();
    const carried: ConnectionChoice = {
      ok: true,
      method: { kind: 'direct', daemonUrl: 'https://alpha.example.test' },
      reason: 'Connected over direct.',
      passedOver: [],
    };
    const view = await mount(page({ connections: [alpha], probe: () => health.promise, carrier: carried }));
    await interact(() =>
      must(
        view.container.querySelector<HTMLButtonElement>('[aria-controls="daemon-settings-tab-host-checks"]'),
        'host checks tab',
      ).click(),
    );

    // A carrier that worked is not permission to skip the probe: this badge is about
    // the daemon answering, and it says `checking` until one does.
    expect(reachability(view.container, 'daemon-alpha')).toBe('checking');
    health.resolve({});
    await settle();
    expect(reachability(view.container, 'daemon-alpha')).toBe('reachable');
    await view.unmount();
  });

  it('resets and fences health when the same daemon is re-paired with a rotated credential', async () => {
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#daemons');
    const oldHealth = deferred<unknown>();
    const newHealth = deferred<unknown>();
    const rotated = daemon('daemon-alpha', 'https://alpha.example.test', 'alpha-rotated', 'Alpha workstation');
    const probe: DaemonReachabilityProbe = connection =>
      connection.deviceToken === 'alpha-secret' ? oldHealth.promise : newHealth.promise;
    const controls = new DaemonControlsStore(memoryStorage());
    const view = await mount(page({ current: alpha, connections: [alpha], controls, probe }));
    await interact(() =>
      must(
        view.container.querySelector<HTMLButtonElement>('[aria-controls="daemon-settings-tab-host-checks"]'),
        'host checks tab',
      ).click(),
    );

    oldHealth.resolve({});
    await settle();
    expect(reachability(view.container, 'daemon-alpha')).toBe('reachable');

    await view.render(page({ current: rotated, connections: [rotated], controls, probe }));
    expect(reachability(view.container, 'daemon-alpha')).toBe('checking');

    // This is a second old-pairing request kept pending across the re-pair. Its
    // answer cannot paint the rotated grant green.
    const stale = deferred<unknown>();
    const fresh = deferred<unknown>();
    const lateProbe: DaemonReachabilityProbe = connection =>
      connection.deviceToken === 'alpha-secret' ? stale.promise : fresh.promise;
    await view.render(page({ current: alpha, connections: [alpha], controls, probe: lateProbe }));
    await view.render(page({ current: rotated, connections: [rotated], controls, probe: lateProbe }));
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
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#daemons');
    const attempts = [deferred<unknown>(), deferred<unknown>()];
    let reads = 0;
    const view = await mount(
      page({
        connections: [alpha],
        probe: () => must(attempts[reads++]?.promise, 'probe attempt'),
      }),
    );
    await interact(() =>
      must(
        view.container.querySelector<HTMLButtonElement>('[aria-controls="daemon-settings-tab-host-checks"]'),
        'host checks tab',
      ).click(),
    );
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

  it('says so when the routed daemon is not in the pairing registry, rather than borrowing another', async () => {
    window.history.replaceState({}, '', '/d/daemon-alpha/settings#daemons');
    const view = await mount(page({ current: alpha, connections: [beta] }));
    const alert = must(view.container.querySelector<HTMLElement>('[role="alert"]'), 'the missing-daemon notice');
    expect(alert.textContent).toContain('not present in the browser’s pairing registry');
    // Showing beta's settings under alpha's route would be the wrong daemon.
    expect(view.container.textContent).not.toContain('Alpha workstation');
    await view.unmount();
  });
});
