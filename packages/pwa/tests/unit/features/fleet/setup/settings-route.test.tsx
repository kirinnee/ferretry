import { describe, expect, it, spyOn } from 'bun:test';
import { useEffect } from 'react';
import {
  machineItemHash,
  machinePanelFromHash,
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
    ['#machines/studio/machine/setup', 'setup'],
    ['#machines/studio/machine/import', 'import'],
    ['#machines/studio/machine/clone', 'clone'],
    ['#machines/studio/machine/export', 'export'],
    ['#machines/studio/machine/install-claude', 'install-claude'],
    ['#machines/studio/machine/install-codex', 'install-codex'],
  ])('reads %s as the %s flow', (hash, flow) => {
    expect(settingsFlowFromHash(hash)).toBe(flow);
  });

  it('reads the Machine tab itself as no flow', () => {
    expect(settingsFlowFromHash('#machines/studio/machine')).toBeNull();
  });

  it('reads an unknown flow word as no flow', () => {
    expect(settingsFlowFromHash('#machines/studio/machine/reboot')).toBeNull();
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
    expect(settingsFlowFromHash('machines/studio/machine/import')).toBe('import');
  });
});

describe('machinePanelFromHash', () => {
  it.each<[string, string]>([
    ['#machines/studio/machine/security', 'security'],
    ['#machines/studio/machine/warden', 'warden'],
    ['#machines/studio/machine/devices', 'devices'],
    ['#machines/studio/machine/security%20log', 'security log'],
  ])('reads %s as the %s panel', (hash, panel) => {
    expect(machinePanelFromHash(hash)).toBe(panel);
  });

  it('reads a flow word as no panel, so a flow is never also a panel', () => {
    for (const flow of ['setup', 'import', 'clone', 'install-claude', 'install-codex']) {
      expect(machinePanelFromHash(`#machines/studio/machine/${flow}`)).toBeNull();
    }
  });

  it('reads the Machine tab itself, another tab, or another section as no panel', () => {
    expect(machinePanelFromHash('#machines/studio/machine')).toBeNull();
    expect(machinePanelFromHash('#machines/studio/runtimes/security')).toBeNull();
    expect(machinePanelFromHash('#appearance')).toBeNull();
    expect(machinePanelFromHash('')).toBeNull();
  });

  it('reads an item that does not decode as neither a panel nor a flow', () => {
    expect(machinePanelFromHash('#machines/studio/machine/%E0%A4%A')).toBeNull();
    expect(settingsFlowFromHash('#machines/studio/machine/%E0%A4%A')).toBeNull();
  });
});

describe('machineItemHash', () => {
  it('is the tab hash when there is no item', () => {
    expect(machineItemHash('studio', 'machine')).toBe('#machines/studio/machine');
  });

  it('appends one encoded item to the tab hash', () => {
    expect(machineItemHash('studio', 'machine', 'clone')).toBe('#machines/studio/machine/clone');
  });

  it('encodes a machine name with spaces so the hash round-trips', () => {
    const hash = machineItemHash('Studio Desk', 'machine', 'setup');
    expect(hash).toBe('#machines/Studio%20Desk/machine/setup');
    expect(settingsFlowFromHash(hash)).toBe('setup');
  });
});

describe('useSettingsFlow', () => {
  it('starts on the flow the address names', async () => {
    const browser = fakeWindow('#machines/studio/machine/import');
    const { mounted, shown } = await renderProbe('studio', browser);
    try {
      expect(shown()).toBe('import');
    } finally {
      await mounted.unmount();
    }
  });

  it('starts on no flow when the address names only the tab', async () => {
    const browser = fakeWindow('#machines/studio/machine');
    const { mounted, shown } = await renderProbe('studio', browser);
    try {
      expect(shown()).toBe('tab');
    } finally {
      await mounted.unmount();
    }
  });

  it('open() writes the flow into the address and shows it', async () => {
    const browser = fakeWindow('#machines/studio/machine');
    const { mounted, current, shown } = await renderProbe('studio', browser);
    try {
      await interact(() => current().open('clone'));
      expect(browser.location.hash).toBe('#machines/studio/machine/clone');
      expect(current().flow).toBe('clone');
      expect(shown()).toBe('clone');
    } finally {
      await mounted.unmount();
    }
  });

  it('open(null) closes the flow back to the tab', async () => {
    const browser = fakeWindow('#machines/studio/machine/clone');
    const { mounted, current, shown } = await renderProbe('studio', browser);
    try {
      await interact(() => current().open(null));
      expect(browser.location.hash).toBe('#machines/studio/machine');
      expect(current().flow).toBeNull();
      expect(shown()).toBe('tab');
    } finally {
      await mounted.unmount();
    }
  });

  it('open() encodes a machine name with spaces into the address', async () => {
    const browser = fakeWindow('#machines/Studio%20Desk/machine');
    const { mounted, current } = await renderProbe('Studio Desk', browser);
    try {
      await interact(() => current().open('setup'));
      expect(browser.location.hash).toBe('#machines/Studio%20Desk/machine/setup');
    } finally {
      await mounted.unmount();
    }
  });

  it('openPanel() writes the panel into the address, and openPanel(null) returns to the tab', async () => {
    const browser = fakeWindow('#machines/studio/machine');
    const { mounted, current } = await renderProbe('studio', browser);
    try {
      expect(current().panel).toBeNull();
      await interact(() => current().openPanel('warden'));
      expect(browser.location.hash).toBe('#machines/studio/machine/warden');
      expect(current().panel).toBe('warden');
      expect(current().flow).toBeNull();
      await interact(() => current().openPanel(null));
      expect(browser.location.hash).toBe('#machines/studio/machine');
      expect(current().panel).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('starts on the panel the address names', async () => {
    const browser = fakeWindow('#machines/studio/machine/security');
    const { mounted, current } = await renderProbe('studio', browser);
    try {
      expect(current().panel).toBe('security');
      expect(current().flow).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('goTo() moves the address to another tab on this machine', async () => {
    const browser = fakeWindow('#machines/studio/machine/setup');
    const { mounted, current } = await renderProbe('studio', browser);
    try {
      await interact(() => current().goTo('runtimes'));
      expect(browser.location.hash).toBe('#machines/studio/runtimes');
    } finally {
      await mounted.unmount();
    }
  });

  it('follows a hashchange to a new flow', async () => {
    const browser = fakeWindow('#machines/studio/machine');
    const { mounted, current, shown } = await renderProbe('studio', browser);
    try {
      browser.location.hash = '#machines/studio/machine/install-codex';
      await hashchange(browser);
      expect(current().flow).toBe('install-codex');
      expect(shown()).toBe('install-codex');
    } finally {
      await mounted.unmount();
    }
  });

  it('a hashchange to an unknown flow word reads as no flow', async () => {
    const browser = fakeWindow('#machines/studio/machine/import');
    const { mounted, current, shown } = await renderProbe('studio', browser);
    try {
      browser.location.hash = '#machines/studio/machine/reboot';
      await hashchange(browser);
      expect(current().flow).toBeNull();
      expect(shown()).toBe('tab');
    } finally {
      await mounted.unmount();
    }
  });

  it('a hashchange to another tab reads as no flow', async () => {
    const browser = fakeWindow('#machines/studio/machine/clone');
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
    const browser = Object.assign(target, { location: { hash: '#machines/studio/machine' } }) as unknown as Window;
    const removed = spyOn(target, 'removeEventListener');
    const { mounted } = await renderProbe('studio', browser);
    await mounted.unmount();
    expect(removed).toHaveBeenCalledWith('hashchange', expect.any(Function));
  });

  it('reads and writes the real window when no browser is passed', async () => {
    window.location.hash = '#machines/studio/machine/install-claude';
    const { mounted, current, shown } = await renderProbe('studio');
    try {
      expect(shown()).toBe('install-claude');
      await interact(() => current().open('import'));
      expect(window.location.hash).toBe('#machines/studio/machine/import');
      await interact(() => current().goTo('machine'));
      expect(window.location.hash).toBe('#machines/studio/machine');
    } finally {
      await mounted.unmount();
      window.location.hash = '';
    }
  });
});
