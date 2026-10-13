import { describe, expect, it, spyOn } from 'bun:test';
import { useEffect } from 'react';
import {
  machineItemHash,
  type SettingsFlow,
  type SettingsFlowRoute,
  settingsFlowFromHash,
  useSettingsFlow,
} from '../../../../../src/features/fleet/setup/settings-route.ts';
import { interact, mount, must } from '../../../../support/dom.ts';

const fakeWindow = (hash: string): Window => {
  const target = new EventTarget();
  return Object.assign(target, { location: { hash } }) as unknown as Window;
};

const hashchange = (browser: Window): Promise<void> =>
  interact(() => {
    browser.dispatchEvent(new Event('hashchange'));
  });

const Probe = ({
  machine,
  browser,
  onRoute,
}: {
  readonly machine: string;
  readonly browser?: Window;
  readonly onRoute: (route: SettingsFlowRoute) => void;
}) => {
  const route = useSettingsFlow(machine, browser);
  useEffect(() => {
    onRoute(route);
  });
  return <span data-testid="flow">{route.flow ?? 'tab'}</span>;
};

const renderProbe = async (machine: string, browser?: Window) => {
  let latest: SettingsFlowRoute | undefined;
  const mounted = await mount(
    <Probe
      machine={machine}
      {...(browser === undefined ? {} : { browser })}
      onRoute={route => {
        latest = route;
      }}
    />,
  );
  const current = (): SettingsFlowRoute => must(latest, 'the probe route');
  const shown = (): string =>
    must(mounted.container.querySelector('[data-testid="flow"]'), 'the flow label').textContent;
  return { mounted, current, shown };
};

describe('settingsFlowFromHash', () => {
  it.each<[string, SettingsFlow]>([
    ['#machines/studio/settings/setup', 'setup'],
    ['#machines/studio/settings/import', 'import'],
    ['#machines/studio/settings/clone', 'clone'],
    ['#machines/studio/settings/migrate', 'migrate'],
    ['#machines/studio/settings/install-claude', 'install-claude'],
    ['#machines/studio/settings/install-codex', 'install-codex'],
  ])('reads %s as the %s flow', (hash, flow) => {
    expect(settingsFlowFromHash(hash)).toBe(flow);
  });

  it('reads the Settings tab itself as no flow', () => {
    expect(settingsFlowFromHash('#machines/studio/settings')).toBeNull();
  });

  it('reads an unknown flow word as no flow', () => {
    expect(settingsFlowFromHash('#machines/studio/settings/reboot')).toBeNull();
  });

  it('reads a flow word on another tab as no flow', () => {
    expect(settingsFlowFromHash('#machines/studio/runtimes/setup')).toBeNull();
    expect(settingsFlowFromHash('#machines/studio/credentials/clone')).toBeNull();
  });

  it('reads an address outside the machines section as no flow', () => {
    expect(settingsFlowFromHash('#fleet/studio/settings/setup')).toBeNull();
    expect(settingsFlowFromHash('')).toBeNull();
    expect(settingsFlowFromHash('#')).toBeNull();
  });

  it('accepts a hash without the leading #', () => {
    expect(settingsFlowFromHash('machines/studio/settings/import')).toBe('import');
  });
});

describe('machineItemHash', () => {
  it('is the tab hash when there is no item', () => {
    expect(machineItemHash('studio', 'settings')).toBe('#machines/studio/settings');
  });

  it('appends one encoded item to the tab hash', () => {
    expect(machineItemHash('studio', 'settings', 'clone')).toBe('#machines/studio/settings/clone');
  });

  it('encodes a machine name with spaces so the hash round-trips', () => {
    const hash = machineItemHash('Studio Desk', 'settings', 'setup');
    expect(hash).toBe('#machines/Studio%20Desk/settings/setup');
    expect(settingsFlowFromHash(hash)).toBe('setup');
  });
});

describe('useSettingsFlow', () => {
  it('starts on the flow the address names', async () => {
    const browser = fakeWindow('#machines/studio/settings/import');
    const { mounted, shown } = await renderProbe('studio', browser);
    try {
      expect(shown()).toBe('import');
    } finally {
      await mounted.unmount();
    }
  });

  it('starts on no flow when the address names only the tab', async () => {
    const browser = fakeWindow('#machines/studio/settings');
    const { mounted, shown } = await renderProbe('studio', browser);
    try {
      expect(shown()).toBe('tab');
    } finally {
      await mounted.unmount();
    }
  });

  it('open() writes the flow into the address and shows it', async () => {
    const browser = fakeWindow('#machines/studio/settings');
    const { mounted, current, shown } = await renderProbe('studio', browser);
    try {
      await interact(() => current().open('clone'));
      expect(browser.location.hash).toBe('#machines/studio/settings/clone');
      expect(current().flow).toBe('clone');
      expect(shown()).toBe('clone');
    } finally {
      await mounted.unmount();
    }
  });

  it('open(null) closes the flow back to the tab', async () => {
    const browser = fakeWindow('#machines/studio/settings/migrate');
    const { mounted, current, shown } = await renderProbe('studio', browser);
    try {
      await interact(() => current().open(null));
      expect(browser.location.hash).toBe('#machines/studio/settings');
      expect(current().flow).toBeNull();
      expect(shown()).toBe('tab');
    } finally {
      await mounted.unmount();
    }
  });

  it('open() encodes a machine name with spaces into the address', async () => {
    const browser = fakeWindow('#machines/Studio%20Desk/settings');
    const { mounted, current } = await renderProbe('Studio Desk', browser);
    try {
      await interact(() => current().open('setup'));
      expect(browser.location.hash).toBe('#machines/Studio%20Desk/settings/setup');
    } finally {
      await mounted.unmount();
    }
  });

  it('goTo() moves the address to another tab on this machine', async () => {
    const browser = fakeWindow('#machines/studio/settings/setup');
    const { mounted, current } = await renderProbe('studio', browser);
    try {
      await interact(() => current().goTo('runtimes'));
      expect(browser.location.hash).toBe('#machines/studio/runtimes');
    } finally {
      await mounted.unmount();
    }
  });

  it('follows a hashchange to a new flow', async () => {
    const browser = fakeWindow('#machines/studio/settings');
    const { mounted, current, shown } = await renderProbe('studio', browser);
    try {
      browser.location.hash = '#machines/studio/settings/install-codex';
      await hashchange(browser);
      expect(current().flow).toBe('install-codex');
      expect(shown()).toBe('install-codex');
    } finally {
      await mounted.unmount();
    }
  });

  it('a hashchange to an unknown flow word reads as no flow', async () => {
    const browser = fakeWindow('#machines/studio/settings/import');
    const { mounted, current, shown } = await renderProbe('studio', browser);
    try {
      browser.location.hash = '#machines/studio/settings/reboot';
      await hashchange(browser);
      expect(current().flow).toBeNull();
      expect(shown()).toBe('tab');
    } finally {
      await mounted.unmount();
    }
  });

  it('a hashchange to another tab reads as no flow', async () => {
    const browser = fakeWindow('#machines/studio/settings/clone');
    const { mounted, current } = await renderProbe('studio', browser);
    try {
      browser.location.hash = '#machines/studio/profiles/clone';
      await hashchange(browser);
      expect(current().flow).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('removes its hashchange listener once unmounted', async () => {
    const target = new EventTarget();
    const browser = Object.assign(target, { location: { hash: '#machines/studio/settings' } }) as unknown as Window;
    const removed = spyOn(target, 'removeEventListener');
    const { mounted } = await renderProbe('studio', browser);
    await mounted.unmount();
    expect(removed).toHaveBeenCalledWith('hashchange', expect.any(Function));
  });

  it('reads and writes the real window when no browser is passed', async () => {
    window.location.hash = '#machines/studio/settings/install-claude';
    const { mounted, current, shown } = await renderProbe('studio');
    try {
      expect(shown()).toBe('install-claude');
      await interact(() => current().open('import'));
      expect(window.location.hash).toBe('#machines/studio/settings/import');
      await interact(() => current().goTo('settings'));
      expect(window.location.hash).toBe('#machines/studio/settings');
    } finally {
      await mounted.unmount();
      window.location.hash = '';
    }
  });
});
