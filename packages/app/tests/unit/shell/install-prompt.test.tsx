import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import { provideToShell } from '../../../src/connect/provides.ts';
import {
  attachInstallPrompt,
  browserInstallEnvironment,
  createBrowserInstallPrompt,
  type DeferredInstallPrompt,
  type InstallEventTarget,
  InstallPromptCapture,
  installPlatform,
  NO_INSTALL_PROMPT,
  useInstallPrompt,
} from '../../../src/shell/install-prompt.ts';
import { interact, type Mounted, mount } from '../../support/dom.ts';
import { bootApp, entryOf, manifestOf, settle } from './frame-fixtures.tsx';

/**
 * THE INSTALL PROMPT, CAPTURED AT BOOT (shell contract S13): the browser's one `beforeinstallprompt` is held before
 * anything renders, spent once, and readable on a daemon-less screen as on any other.
 */

/** A target that records its listeners, so a test fires the browser's events by hand. */
class FakeWindow implements InstallEventTarget {
  readonly listeners = new Map<string, ((event: Event) => void)[]>();
  addEventListener(type: 'beforeinstallprompt' | 'appinstalled', listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: 'beforeinstallprompt' | 'appinstalled', event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  readonly navigator = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130', maxTouchPoints: 0 };
  matchMedia(): { readonly matches: boolean } {
    return { matches: false };
  }
}

/** The browser's event: preventDefault, a prompt that resolves, and a user choice. */
function offer(outcome: 'accepted' | 'dismissed' | 'throws' = 'accepted') {
  const calls = { prevented: 0, prompted: 0 };
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt: async () => {
      calls.prompted += 1;
      if (outcome === 'throws') throw new Error('not allowed');
    },
    userChoice: Promise.resolve({ outcome: outcome === 'throws' ? 'dismissed' : outcome }),
  }) as Event & DeferredInstallPrompt;
  const realPrevent = event.preventDefault.bind(event);
  event.preventDefault = () => {
    calls.prevented += 1;
    realPrevent();
  };
  return { event, calls };
}

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe('the held prompt', () => {
  test('shell S13: an event before anything mounts is held (and the mini-infobar is suppressed)', () => {
    const win = new FakeWindow();
    const capture = createBrowserInstallPrompt(win);
    expect(capture.snapshot()).toEqual({ platform: 'browser', canPrompt: false });
    const { event, calls } = offer();
    win.fire('beforeinstallprompt', event);
    expect(calls.prevented).toBe(1);
    expect(capture.snapshot()).toEqual({ platform: 'browser', canPrompt: true });
  });

  test('shell S13: prompting spends it: accepted marks the app installed, and a second prompt is unavailable', async () => {
    const win = new FakeWindow();
    const capture = createBrowserInstallPrompt(win);
    const { event, calls } = offer('accepted');
    win.fire('beforeinstallprompt', event);
    const seen: string[] = [];
    capture.subscribe(() => seen.push(JSON.stringify(capture.snapshot())));
    expect(await capture.prompt()).toBe('accepted');
    expect(calls.prompted).toBe(1);
    expect(capture.snapshot()).toEqual({ platform: 'installed', canPrompt: false });
    expect(await capture.prompt()).toBe('unavailable');
    expect(calls.prompted).toBe(1);
    expect(seen.length).toBeGreaterThan(0);
  });

  test('shell S13: a dismissed prompt is spent too (the browser’s rule) and the platform stays', async () => {
    const win = new FakeWindow();
    const capture = createBrowserInstallPrompt(win);
    win.fire('beforeinstallprompt', offer('dismissed').event);
    expect(await capture.prompt()).toBe('dismissed');
    expect(capture.snapshot()).toEqual({ platform: 'browser', canPrompt: false });
    expect(await capture.prompt()).toBe('unavailable');
  });

  test('shell S13: a prompt the browser refuses to open answers unavailable, and is released', async () => {
    const win = new FakeWindow();
    const capture = createBrowserInstallPrompt(win);
    win.fire('beforeinstallprompt', offer('throws').event);
    expect(await capture.prompt()).toBe('unavailable');
    expect(capture.snapshot().canPrompt).toBe(false);
  });

  test('shell S13: appinstalled marks the app installed and drops a held prompt', () => {
    const win = new FakeWindow();
    const capture = createBrowserInstallPrompt(win);
    win.fire('beforeinstallprompt', offer().event);
    win.fire('appinstalled', new Event('appinstalled'));
    expect(capture.snapshot()).toEqual({ platform: 'installed', canPrompt: false });
  });

  test('shell S13: attachInstallPrompt wires an existing capture to a target', () => {
    const win = new FakeWindow();
    const capture = new InstallPromptCapture('browser');
    attachInstallPrompt(capture, win);
    win.fire('beforeinstallprompt', offer().event);
    expect(capture.snapshot().canPrompt).toBe(true);
  });
});

describe('the platform', () => {
  const env = (extra: Partial<Parameters<typeof installPlatform>[0]> = {}) => ({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130',
    maxTouchPoints: 0,
    standaloneDisplay: false,
    ...extra,
  });
  test('shell S13: an installed display, iOS Safari’s own flag, iPhone, iPad as a Mac, and anything else', () => {
    expect(installPlatform(env({ standaloneDisplay: true }))).toBe('installed');
    expect(installPlatform(env({ navigatorStandalone: true }))).toBe('installed');
    expect(installPlatform(env({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' }))).toBe('ios');
    expect(
      installPlatform(env({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', maxTouchPoints: 5 })),
    ).toBe('ios');
    expect(
      installPlatform(env({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', maxTouchPoints: 0 })),
    ).toBe('browser');
    expect(installPlatform(env())).toBe('browser');
  });

  test('shell S13: on iOS canPrompt is false: there is no event, only the Share sheet', () => {
    const win = new FakeWindow();
    (win as { navigator: unknown }).navigator = {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      maxTouchPoints: 5,
    };
    const capture = createBrowserInstallPrompt(win);
    expect(capture.snapshot()).toEqual({ platform: 'ios', canPrompt: false });
  });

  test('shell S13: the environment is read from the window once', () => {
    const win = new FakeWindow();
    expect(browserInstallEnvironment(win)).toEqual({
      userAgent: win.navigator.userAgent,
      maxTouchPoints: 0,
      standaloneDisplay: false,
      navigatorStandalone: undefined,
    });
  });
});

describe('useInstallPrompt', () => {
  const seen: { platform: string; canPrompt: boolean }[] = [];
  let spend: (() => Promise<string>) | undefined;
  function Probe(): ReactNode {
    const install = useInstallPrompt();
    seen.push({ platform: install.platform, canPrompt: install.canPrompt });
    spend = install.prompt;
    return <p data-testid="install">{install.canPrompt ? 'can install' : 'cannot install'}</p>;
  }
  const manifest = manifestOf('probe', {
    ui: {
      screens: [
        { id: 'land', path: '/land', daemonless: true },
        { id: 'main', path: 'main' },
      ],
      panels: [{ id: 'offer', slot: 'device.settings', order: 5 }],
    },
  });
  const probe = entryOf(
    manifest,
    provideToShell(implementApp(manifest, { build: () => ({ screens: { main: Probe } }) }), {
      daemonless: () => ({ land: Probe }),
      deviceSettings: { offer: Probe },
    }),
  );

  afterEach(() => {
    seen.length = 0;
    spend = undefined;
  });

  test('shell S13: works under WithoutShell: a daemon-less screen reads the held prompt and spends it', async () => {
    const win = new FakeWindow();
    const capture = createBrowserInstallPrompt(win);
    win.fire('beforeinstallprompt', offer().event);
    const app = await bootApp({ surfaces: [probe], machines: ['d1', 'd2'], path: '/land', install: capture });
    view = app.view;
    expect(app.view.container.textContent).toContain('can install');
    let outcome: string | undefined;
    await interact(async () => {
      outcome = await spend?.();
    });
    expect(outcome).toBe('accepted');
    await settle();
    expect(app.view.container.querySelector('[data-testid="install"]')?.textContent).toBe('cannot install');
    expect(seen.at(-1)?.platform).toBe('installed');
  });

  test('shell S13: works in a device settings panel with no machine, and in a per-daemon view', async () => {
    const win = new FakeWindow();
    const capture = createBrowserInstallPrompt(win);
    const app = await bootApp({ surfaces: [probe], machines: [], path: '/settings', install: capture });
    view = app.view;
    expect(app.view.container.textContent).toContain('cannot install');
    await interact(() => win.fire('beforeinstallprompt', offer().event));
    expect(app.view.container.textContent).toContain('can install');
    await view.unmount();
    const perDaemon = await bootApp({ surfaces: [probe], machines: ['d1'], path: '/d/d1/main', install: capture });
    view = perDaemon.view;
    expect(perDaemon.view.container.textContent).toContain('can install');
  });

  test('shell S13: outside an app shell the prompt is never offered, and the inert holder says so', async () => {
    const outside = await mount(<Probe />);
    expect(outside.container.textContent).toContain('cannot install');
    expect(seen.at(-1)).toEqual({ platform: 'browser', canPrompt: false });
    expect(await spend?.()).toBe('unavailable');
    await outside.unmount();
    expect(NO_INSTALL_PROMPT.snapshot()).toEqual({ platform: 'browser', canPrompt: false });
    expect(await NO_INSTALL_PROMPT.prompt()).toBe('unavailable');
    expect(NO_INSTALL_PROMPT.subscribe(() => {})()).toBeUndefined();
  });
});
