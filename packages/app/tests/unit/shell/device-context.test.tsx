import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp, type Manifest } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import { DaemonControlsStore } from '../../../src/compose/controls.ts';
import { useDeviceControls } from '../../../src/compose/device-controls.ts';
import { provideToShell, registeredDaemonless, type DaemonlessPorts } from '../../../src/connect/provides.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { App } from '../../../src/shell/app.tsx';
import { ShellProvider, type ShellWindow, WithoutShell } from '../../../src/shell/context.tsx';
import {
  type DeviceTheme,
  NO_INSTALL_PROMPT,
  useDeviceTheme,
  useOptionalDevice,
} from '../../../src/shell/device-context.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { ThemePreferenceStore } from '../../../src/theme/preferences.ts';
import { PageThemeSwitch } from '../../../src/ui/theme-toggle.tsx';
import { interact, type Mounted, mount } from '../../support/dom.ts';
import { CORE } from '../client/fixtures.ts';

/**
 * THE DEVICE CONTEXT (shell contract S9): this device's theme and paired list, set ABOVE `WithoutShell`, so a
 * daemon-less screen reads the same theme the device settings page writes, and carries no client.
 */

const manifest = {
  id: 'welcome',
  title: 'Welcome',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view'],
  ui: { screens: [{ id: 'landing', path: '/landing', daemonless: true }] },
} as unknown as Manifest;

const seen: { theme?: DeviceTheme | null } = {};
function Landing(): ReactNode {
  const theme = useDeviceTheme();
  seen.theme = theme;
  return (
    <div>
      <button type="button" data-testid="mission" onClick={() => theme?.setFamily('mission')}>
        Mission
      </button>
      <button type="button" data-testid="dark" onClick={() => theme?.setMode('dark')}>
        Dark
      </button>
      <button type="button" data-testid="large" onClick={() => theme?.setTextScale('large')}>
        Large
      </button>
    </div>
  );
}
const half = provideToShell(implementApp(manifest, { build: () => ({}) }), {
  daemonless: () => ({ landing: Landing }),
});
const entry: SurfaceEntry = {
  id: 'welcome',
  title: 'Welcome',
  core: false,
  contract: 'h-welcome',
  consumes: [],
  manifest,
  app: half,
};
const surfaces: SurfaceEntry[] = [...CORE, entry];

function browserOf(dark: boolean): ShellWindow {
  return {
    matchMedia: query => ({
      matches: query.includes('prefers-color-scheme') ? dark : false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    document: { documentElement: document.documentElement },
  };
}

function parts() {
  const storage = memoryStore();
  const daemons = new DaemonList({ storage, now: () => 1 });
  const runtime = new ShellRuntime({
    appVersion: '5.1.0',
    surfaces,
    daemons,
    connect: async () => undefined,
    daemonless: { views: registeredDaemonless(surfaces, {} as DaemonlessPorts).views, location: () => '' },
  });
  return { storage, daemons, runtime, themes: new ThemePreferenceStore(storage) };
}

const go = (path: string): void => window.history.replaceState({}, '', path);
let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  go('/');
});

const click = async (target: Element | null | undefined): Promise<void> => {
  await interact(() => (target as HTMLElement).click());
};

describe('the device context', () => {
  test('a theme switch on a daemon-less screen changes the document theme, and the device settings page shows it', async () => {
    go('/landing');
    const { runtime, themes, storage } = parts();
    view = await mount(
      <App
        runtime={runtime}
        themes={themes}
        layouts={new DeviceLayoutStore(storage)}
        browser={browserOf(false)}
        scroll={new ScrollMemory(null)}
      />,
    );
    expect(seen.theme?.preference.family).toBe('studio');
    expect(seen.theme?.resolved).toBe('light');
    await click(view.container.querySelector('[data-testid="mission"]'));
    expect(document.documentElement.dataset.theme).toBe('mission-light');
    await click(view.container.querySelector('[data-testid="dark"]'));
    expect(document.documentElement.dataset.theme).toBe('mission-dark');
    await click(view.container.querySelector('[data-testid="large"]'));
    expect(document.documentElement.dataset.textScale).toBe('large');
    // The device settings page reads the same store: it shows the value the daemon-less screen chose.
    await view.unmount();
    go('/settings');
    view = await mount(
      <App
        runtime={runtime}
        themes={themes}
        layouts={new DeviceLayoutStore(storage)}
        browser={browserOf(false)}
        scroll={new ScrollMemory(null)}
      />,
    );
    const selects = [...view.container.querySelectorAll('select')].map(select => select.value);
    expect(selects).toContain('mission');
    expect(selects).toContain('dark');
  });

  test('every daemon-less safe hook built so far answers under WithoutShell; the device context holds no client', async () => {
    const { runtime, themes, storage, daemons } = parts();
    daemons.add({ daemon: 'd1', machine: 'laptop', deviceId: 'dev', address: 'http://127.0.0.1:40245' });
    const controls = new DaemonControlsStore(memoryStore());
    const got: { theme?: DeviceTheme | null; keys?: readonly string[]; vim?: boolean; paired?: number } = {};
    function Probe(): ReactNode {
      got.theme = useDeviceTheme();
      const device = useOptionalDevice();
      got.keys = device === null ? [] : Object.keys(device).sort();
      got.paired = device?.daemons.snapshot().daemons.length;
      got.vim = useDeviceControls(controls).device.composerVimMode;
      return null;
    }
    view = await mount(
      <ShellProvider
        runtime={runtime}
        themes={themes}
        layouts={new DeviceLayoutStore(storage)}
        browser={browserOf(true)}
        scroll={new ScrollMemory(null)}
      >
        <WithoutShell>
          <Probe />
        </WithoutShell>
      </ShellProvider>,
    );
    expect(got.theme?.resolved).toBe('dark');
    expect(got.paired).toBe(1);
    expect(got.vim).toBe(false);
    // Device state only: the theme, the OS answer, the install holder and the paired list — no client, no runtime.
    expect(got.keys).toEqual(['daemons', 'install', 'systemDark', 'theme']);
    expect(NO_INSTALL_PROMPT.current()).toBeUndefined();
  });

  test('outside an app shell there is no device theme', async () => {
    function Probe(): ReactNode {
      seen.theme = useDeviceTheme();
      return null;
    }
    view = await mount(<Probe />);
    expect(seen.theme).toBeNull();
  });
});

describe('the page theme switch', () => {
  async function openSwitch(): Promise<{ themes: ThemePreferenceStore }> {
    const { runtime, themes, storage } = parts();
    view = await mount(
      <ShellProvider
        runtime={runtime}
        themes={themes}
        layouts={new DeviceLayoutStore(storage)}
        browser={browserOf(false)}
        scroll={new ScrollMemory(null)}
      >
        <WithoutShell>
          <p data-testid="outside">outside</p>
          <PageThemeSwitch />
        </WithoutShell>
      </ShellProvider>,
    );
    return { themes };
  }
  const trigger = (): HTMLElement => view?.container.querySelector('[data-theme-trigger]') as HTMLElement;
  const panel = (): Element | null => view?.container.querySelector('[role="dialog"]') ?? null;

  test('opens on the family in force, switches mode and family without closing, and Done closes', async () => {
    const { themes } = await openSwitch();
    expect(trigger().getAttribute('aria-label')).toBe('Theme: Studio, Auto (light)');
    await click(trigger());
    expect(panel()).not.toBeNull();
    expect((document.activeElement as HTMLInputElement).dataset.family).toBe('studio');
    await click(view?.container.querySelector('input[data-mode="dark"]'));
    await click(view?.container.querySelector('input[data-family="neo"]'));
    expect(themes.snapshot()).toMatchObject({ family: 'neo', mode: 'dark' });
    expect(panel()).not.toBeNull();
    expect(trigger().getAttribute('aria-label')).toBe('Theme: Neo-Brutalism, Dark');
    await click(view?.container.querySelector('[data-theme-done]'));
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    // The trigger toggles: open, then a second press closes.
    await click(trigger());
    await click(trigger());
    expect(panel()).toBeNull();
  });

  test('the arrow keys, Home and End walk the families and reveal the card', async () => {
    const { themes } = await openSwitch();
    await click(trigger());
    const list = view?.container.querySelector('[aria-label="Theme family"]') as HTMLElement;
    const press = async (key: string): Promise<void> => {
      await interact(() => list.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
    };
    await press('ArrowDown');
    expect(themes.snapshot().family).toBe('mission');
    await press('ArrowRight');
    expect(themes.snapshot().family).toBe('neo');
    await press('ArrowUp');
    await press('ArrowLeft');
    expect(themes.snapshot().family).toBe('studio');
    await press('End');
    expect(themes.snapshot().family).toBe('ma');
    await press('Home');
    expect(themes.snapshot().family).toBe('studio');
    await press('x');
    expect(themes.snapshot().family).toBe('studio');
    // The frame after a family change re-reveals the focused card.
    await interact(() => new Promise(resolve => setTimeout(resolve, 30)));
    expect((document.activeElement as HTMLInputElement).dataset.family).toBe('studio');
  });

  test('Escape, a press outside, the scrim and the ✕ each close it', async () => {
    await openSwitch();
    await click(trigger());
    await interact(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })));
    expect(panel()).not.toBeNull();
    await interact(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(panel()).toBeNull();
    await click(trigger());
    await interact(() => panel()?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(panel()).not.toBeNull();
    await interact(() =>
      view?.container
        .querySelector('[data-testid="outside"]')
        ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
    );
    expect(panel()).toBeNull();
    await click(trigger());
    await click(view?.container.querySelector('[data-theme-backdrop]'));
    expect(panel()).toBeNull();
    await click(trigger());
    await click(view?.container.querySelector('[data-theme-close]'));
    expect(panel()).toBeNull();
  });

  test('Tab cycles inside the panel, both ways', async () => {
    await openSwitch();
    await click(trigger());
    const dialog = panel() as HTMLElement;
    const tab = async (shiftKey: boolean): Promise<void> => {
      await interact(() =>
        (document.activeElement ?? dialog).dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true }),
        ),
      );
    };
    const done = dialog.querySelector('[data-theme-done]') as HTMLElement;
    const close = dialog.querySelector('[data-theme-close]') as HTMLElement;
    await interact(() => done.focus());
    await tab(false);
    expect(document.activeElement).toBe(close);
    await tab(true);
    expect(document.activeElement).toBe(done);
    // In the middle, Tab is the browser's own.
    const mode = dialog.querySelector('input[data-mode="system"]') as HTMLElement;
    await interact(() => mode.focus());
    await tab(false);
    await tab(true);
    expect(document.activeElement).toBe(mode);
    await interact(() => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })));
  });

  test('the software keyboard closes it, and a narrow screen slides the panel inside', async () => {
    await openSwitch();
    const rect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this.getAttribute('role') === 'dialog'
        ? ({ left: -20, right: 252, top: 0, bottom: 10 } as DOMRect)
        : rect.call(this);
    };
    try {
      await click(trigger());
      expect((panel() as HTMLElement).style.transform).toBe('translateX(28px)');
    } finally {
      HTMLElement.prototype.getBoundingClientRect = rect;
    }
    await interact(async () => {
      document.documentElement.setAttribute('data-keyboard', 'open');
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(panel()).toBeNull();
    document.documentElement.removeAttribute('data-keyboard');
  });

  test('on a phone, and outside an app shell, it draws nothing', async () => {
    view = await mount(<PageThemeSwitch />);
    expect(view.container.innerHTML).toBe('');
    await view.unmount();
    const happy = (window as unknown as { happyDOM: { setInnerWidth: (width: number) => void } }).happyDOM;
    const width = window.innerWidth;
    happy.setInnerWidth(500);
    try {
      await openSwitch();
      expect(view?.container.querySelector('[data-page-theme-switch]')).toBeNull();
    } finally {
      happy.setInnerWidth(width);
    }
  });
});
