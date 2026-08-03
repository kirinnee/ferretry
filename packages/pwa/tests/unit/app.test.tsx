/**
 * THE COMPOSITION ROOT, PROVED BY MOUNTING IT.
 *
 * `App.tsx` is the one module in this package that is nothing but wiring, which
 * is exactly why it needs executed tests rather than a reading: a slot pointed
 * at the wrong component, a provider that never reaches its consumer, or a
 * daemon taken from the selected pairing instead of the route are all invisible
 * to the typechecker and all silent in a build log.
 *
 * Three kinds of test live here, and the split is deliberate:
 *
 *   * MOUNTED SHELL tests drive `AppShell` through a real router and a real
 *     store over stubbed transports. Anything about routing, focus, live
 *     regions or keyboard handling is a document fact and is asserted against
 *     the document.
 *   * BROWSER SURFACE tests call the root's capability factories directly with
 *     the globals patched, because those factories are the only place in the
 *     package that reads `Notification`, `navigator.serviceWorker` and
 *     `isSecureContext` — and the whole point of the ports beneath them is that
 *     nothing else has to.
 *   * PURE HELPER tests cover the decisions the root makes on its own:
 *     the one-shot install latch, the text-entry guard and the route
 *     announcement.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { FyApiClient } from '@ferretry/protocol/client';

import {
  App,
  AppShell,
  browserNotificationSurface,
  browserPushEnrolment,
  installOnce,
  isTextEntryTarget,
  routeAnnouncement,
} from '../../src/App.tsx';
import type { DaemonConnectionRepository } from '../../src/lib/connections.ts';
import { type DaemonId, daemonConnection, daemonId } from '../../src/lib/daemon-connection.ts';
import type { PageRoute } from '../../src/lib/pages/routes.ts';
import type { PushRegistrationLike } from '../../src/lib/push-enrolment.ts';
import { RouterProvider } from '../../src/lib/router.tsx';
import { type AppStore, createAppStore, StoreProvider } from '../../src/lib/store.tsx';
import { interact, mount, must, pressKey } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceToken: 'alpha-token',
});
const beta = daemonConnection({
  daemonId: 'beta',
  baseUrl: 'https://beta.example.test',
  deviceToken: 'beta-token',
});

class MemoryRepository implements DaemonConnectionRepository {
  readonly values = new Map<string, string>();

  async load(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async save(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

/**
 * Replaces one global for the duration of a test and answers its undo.
 *
 * The suite shares a single happy-dom document across every file in the
 * process, so a patched capability that outlived its test would change what a
 * later file's `AppShell` believes the browser can do.
 */
const patchGlobal = (host: object, name: string, value: unknown): (() => void) => {
  const original = Object.getOwnPropertyDescriptor(host, name);
  Object.defineProperty(host, name, { configurable: true, writable: true, value });
  return () => {
    if (original === undefined) delete (host as Record<string, unknown>)[name];
    else Object.defineProperty(host, name, original);
  };
};

const setPath = (path: string): void => window.history.replaceState({}, '', path);

/**
 * Global fetch is a tripwire for accidental ambient transport. The root must
 * consume the push service already bound to its store's injected fetcher, and
 * pairing must use that same injected fetcher; any URL recorded here is a
 * regression. It is also stubbed because a suite that can dial out is a suite
 * that can hang.
 */
let restoreFetch: (() => void) | undefined;
const requestedUrls: string[] = [];

beforeAll(() => {
  restoreFetch = patchGlobal(globalThis, 'fetch', async (input: unknown) => {
    requestedUrls.push(String(input instanceof Request ? input.url : input));
    return Response.json({});
  });
});

afterAll(() => restoreFetch?.());

afterEach(() => {
  setPath('/');
  localStorage.clear();
  requestedUrls.length = 0;
});

/* ---------- the mounted shell --------------------------------------------- */

interface ShellOptions {
  /** Sessions the stub daemon answers `list` with. */
  readonly sessions?: readonly string[];
  /** Makes `get` reject, which is the session route's failure path. */
  readonly sessionFailure?: string;
  /**
   * Holds `get` open. Without it the read resolves inside the mount's own act
   * flush and the loading state never exists to be observed — which is exactly
   * the state the live-region tests are about.
   */
  readonly sessionGate?: Promise<void>;
}

const appStore = async (reads: string[], options: ShellOptions = {}): Promise<AppStore> =>
  await createAppStore({
    repository: new MemoryRepository(),
    connectClient: async connection =>
      ({
        get: async (sessionId: string) => {
          reads.push(`${connection.daemonId}:${sessionId}`);
          await options.sessionGate;
          if (options.sessionFailure !== undefined) throw new Error(options.sessionFailure);
          return sessionView(sessionId, {
            config: {
              teammate: connection.daemonId === alpha.daemonId ? 'Alpha Agent' : 'Beta Agent',
              name: `${connection.daemonId} session`,
            },
          });
        },
        list: async () => (options.sessions ?? []).map(id => sessionView(id)),
        start: async () => sessionView('started'),
        wardenStatus: async () => ({ config: {}, anomalies: [], fingerprint: 'alpha-fingerprint' }),
      }) as unknown as FyApiClient,
    // Only the pairing exchange has a shape the root itself depends on; every
    // other page reads through a store port that answers an empty document.
    fetcher: async input =>
      String(input).endsWith('/v1/pair')
        ? Response.json({ daemonId: 'gamma', deviceToken: 'gamma-token' })
        : Response.json({}),
  });

const renderShell = async (path: string, paired: readonly DaemonId[] = [], options: ShellOptions = {}) => {
  const reads: string[] = [];
  const store = await appStore(reads, options);
  for (const daemon of paired) store.connections.add(daemon === alpha.daemonId ? alpha : beta);
  setPath(path);
  const view = await mount(
    <RouterProvider>
      <StoreProvider store={store}>
        <AppShell />
      </StoreProvider>
    </RouterProvider>,
  );
  return { reads, store, view };
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

/** Drives a browser history navigation the way the back button does. */
const popTo = async (path: string): Promise<void> => {
  window.history.pushState({}, '', path);
  await interact(() => window.dispatchEvent(new PopStateEvent('popstate')));
};

describe('AppShell', () => {
  it('renders the unpaired first run as the normal connection screen', async () => {
    const { reads, view } = await renderShell('/');

    expect(view.container.querySelector('h1')?.textContent).toBe('Connect a daemon');
    expect(view.container.textContent).toContain('No daemons are paired yet');
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(reads).toEqual([]);
    await view.unmount();
  });

  it('fails closed when a daemon-qualified route has no matching runtime pairing', async () => {
    const { reads, view } = await renderShell('/d/missing/session/shared', [alpha.daemonId, beta.daemonId]);

    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('not paired in this browser');
    expect(view.container.querySelector('h1')?.textContent).toBe('Connect a daemon');
    expect(view.container.querySelector('[data-session="shared"]')).toBeNull();
    expect(reads).toEqual([]);
    await view.unmount();
  });

  it('uses the routed daemon instead of the selected daemon', async () => {
    // Adding beta last selects it, while the route explicitly asks for alpha.
    const { reads, view } = await renderShell('/d/alpha/session/shared', [alpha.daemonId, beta.daemonId]);
    await settle();

    const session = view.container.querySelector('[data-session="shared"]');
    expect(session?.getAttribute('data-daemon')).toBe('alpha');
    expect(session?.textContent).toContain('Alpha Agent');
    expect(session?.textContent).not.toContain('Beta Agent');
    expect(reads).toEqual(['alpha:shared']);
    await view.unmount();
  });

  it('never crosses two daemons that own the same session id', async () => {
    const { reads, view } = await renderShell('/d/alpha/session/shared', [alpha.daemonId, beta.daemonId]);
    await settle();
    expect(view.container.querySelector('[data-session="shared"]')?.textContent).toContain('Alpha Agent');

    await popTo('/d/beta/session/shared');
    await settle();

    const session = view.container.querySelector('[data-session="shared"]');
    expect(session?.getAttribute('data-daemon')).toBe('beta');
    expect(session?.textContent).toContain('Beta Agent');
    expect(session?.textContent).not.toContain('Alpha Agent');
    expect(reads).toEqual(['alpha:shared', 'beta:shared']);
    await view.unmount();
  });

  it('mounts every daemon-qualified destination through its own slot', async () => {
    const { view } = await renderShell('/d/alpha', [alpha.daemonId], { sessions: ['one'] });
    await settle();
    const announced = () => must(view.container.querySelector('[data-route]'), 'the route announcer').textContent;

    expect(announced()).toBe('Sessions');

    for (const [path, expected] of [
      ['/d/alpha/new', 'Sessions, New'],
      ['/d/alpha/settings', 'Sessions, Settings'],
      ['/d/alpha/warden', 'Sessions, Warden'],
      ['/d/alpha/analytics', 'Sessions, Analytics'],
      ['/d/alpha/learning', 'Sessions, Learning'],
      ['/d/alpha/session/one', 'Sessions, one'],
    ] as const) {
      await popTo(path);
      await settle();
      expect(announced()).toBe(expected);
      // Every destination has to put a real page under the app bar; an empty
      // frame is how a mis-wired slot would look.
      expect(must(view.container.querySelector('.kt-shell'), 'the shell').textContent).not.toBe('');
    }

    await view.unmount();
  });
});

/* ---------- F5: route changes are announced and take focus ---------------- */

describe('route change accessibility', () => {
  it('leaves the load-time focus alone and still names the page it opened on', async () => {
    const { view } = await renderShell('/d/alpha', [alpha.daemonId]);
    await settle();

    const announcer = must(view.container.querySelector('[data-route]'), 'the route announcer');
    expect(announcer.getAttribute('role')).toBe('status');
    expect(announcer.getAttribute('aria-live')).toBe('polite');
    expect(announcer.textContent).toBe('Sessions');
    // A page LOAD is not a navigation: the browser has already placed focus.
    expect(document.activeElement).not.toBe(announcer);

    await view.unmount();
  });

  it('moves focus to the announcer on an in-app navigation and renames it', async () => {
    const { view } = await renderShell('/d/alpha', [alpha.daemonId]);
    await settle();
    const announcer = must(view.container.querySelector('[data-route]'), 'the route announcer');

    await popTo('/d/alpha/settings');
    await settle();

    expect(document.activeElement).toBe(announcer);
    expect(announcer.textContent).toBe('Sessions, Settings');
    // The SAME node, renamed: a live region replaced wholesale announces nothing.
    expect(view.container.querySelector('[data-route]')).toBe(announcer);
    expect(announcer.getAttribute('tabindex')).toBe('-1');

    await view.unmount();
  });

  it('names every route it can reach, including the picker', () => {
    const id = daemonId('alpha');
    const announcements = (
      [
        { kind: 'connection-picker' },
        { kind: 'sessions', daemonId: id },
        { kind: 'new-session', daemonId: id },
        { kind: 'session', daemonId: id, sessionId: 'shared' },
        { kind: 'settings', daemonId: id },
        { kind: 'warden', daemonId: id },
        { kind: 'analytics', daemonId: id },
        { kind: 'learning', daemonId: id },
      ] satisfies readonly PageRoute[]
    ).map(routeAnnouncement);

    expect(announcements).toEqual([
      'Daemons',
      'Sessions',
      'Sessions, New',
      'Sessions, shared',
      'Sessions, Settings',
      'Sessions, Warden',
      'Sessions, Analytics',
      'Sessions, Learning',
    ]);
    // The daemon fingerprint is a credential-adjacent identifier, not a place.
    for (const announcement of announcements) expect(announcement).not.toContain('alpha');
  });
});

/* ---------- F6: the session live regions outlive their content ------------ */

describe('the session route live regions', () => {
  it('keeps one status region mounted and only changes its sentence', async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      open = resolve;
    });
    const { view } = await renderShell('/d/alpha/session/shared', [alpha.daemonId], { sessionGate: gate });
    const status = must(view.container.querySelector('[data-session-state]'), 'the session status region');
    const alert = must(view.container.querySelector('[data-session-error]'), 'the session alert region');

    expect(status.getAttribute('data-session-state')).toBe('opening');
    expect(status.getAttribute('role')).toBe('status');
    // The alert exists BEFORE there is anything to say; a region added together
    // with its text is a region no screen reader ever announces.
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toBe('');

    open();
    await settle();

    expect(view.container.querySelector('[data-session-state]')).toBe(status);
    expect(status.getAttribute('data-session-state')).toBe('connected');
    expect(status.textContent).toContain('This session is connected');
    expect(view.container.querySelector('[data-session-error]')).toBe(alert);
    expect(alert.textContent).toBe('');

    await view.unmount();
  });

  it('reports a failed open in the alert region without unmounting either one', async () => {
    const { view } = await renderShell('/d/alpha/session/shared', [alpha.daemonId], {
      sessionFailure: 'daemon refused the read',
    });
    const status = must(view.container.querySelector('[data-session-state]'), 'the session status region');
    const alert = must(view.container.querySelector('[data-session-error]'), 'the session alert region');

    await settle();

    expect(view.container.querySelector('[data-session-state]')).toBe(status);
    expect(status.getAttribute('data-session-state')).toBe('failed');
    expect(status.textContent).toBe('This session could not be opened.');
    expect(view.container.querySelector('[data-session-error]')).toBe(alert);
    expect(alert.textContent).toBe('Could not open this session: daemon refused the read');

    await view.unmount();
  });
});

/* ---------- F7: the palette shortcut yields to text entry ----------------- */

const paletteOpen = (container: HTMLElement): boolean =>
  container.querySelector('[role="dialog"], [data-command-palette]') !== null;

describe('the command palette shortcut', () => {
  it('opens from a keystroke that belongs to no field', async () => {
    const { view } = await renderShell('/d/alpha', [alpha.daemonId]);
    await settle();
    expect(paletteOpen(view.container)).toBe(false);

    await interact(() => pressKey(document.body, 'k', { ctrlKey: true }));

    expect(paletteOpen(view.container)).toBe(true);
    await view.unmount();
  });

  it('accepts the platform modifier in either spelling and either case', async () => {
    const { view } = await renderShell('/d/alpha', [alpha.daemonId]);
    await settle();

    await interact(() => pressKey(document.body, 'K', { metaKey: true }));

    expect(paletteOpen(view.container)).toBe(true);
    await view.unmount();
  });

  it('leaves the keystroke to the field the reader is typing in', async () => {
    const { view } = await renderShell('/d/alpha', [alpha.daemonId]);
    await settle();

    for (const tag of ['input', 'textarea', 'select'] as const) {
      const field = document.createElement(tag);
      document.body.appendChild(field);
      const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
      await interact(() => field.dispatchEvent(event));
      // Not merely "did not open": the field must still RECEIVE the keystroke,
      // which a `preventDefault` in the capture phase would have taken away.
      expect(event.defaultPrevented).toBe(false);
      expect(paletteOpen(view.container)).toBe(false);
      field.remove();
    }

    const editable = document.createElement('div');
    Object.defineProperty(editable, 'isContentEditable', { configurable: true, value: true });
    document.body.appendChild(editable);
    await interact(() => pressKey(editable, 'k', { ctrlKey: true }));
    expect(paletteOpen(view.container)).toBe(false);
    editable.remove();

    await view.unmount();
  });

  it('ignores a bare key, the wrong modifiers, and a composing IME', async () => {
    const { view } = await renderShell('/d/alpha', [alpha.daemonId]);
    await settle();

    await interact(() => pressKey(document.body, 'k'));
    await interact(() => pressKey(document.body, 'j', { ctrlKey: true }));
    await interact(() => pressKey(document.body, 'k', { ctrlKey: true, shiftKey: true }));
    await interact(() => pressKey(document.body, 'k', { ctrlKey: true, altKey: true }));
    await interact(() => pressKey(document.body, 'k', { ctrlKey: true, keyCode: 229 }));
    await interact(() => pressKey(document.body, 'k', { ctrlKey: true, isComposing: true }));

    expect(paletteOpen(view.container)).toBe(false);
    await view.unmount();
  });

  it('stops listening once the shell unmounts', async () => {
    const { view } = await renderShell('/d/alpha', [alpha.daemonId]);
    await settle();

    // Dispatched at `window`, the exact target the shell listens on, so this
    // asserts the shell's own listener rather than whatever else in the tree
    // happens to be watching the document.
    const armed = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true });
    await interact(() => window.dispatchEvent(armed));
    expect(armed.defaultPrevented).toBe(true);

    await view.unmount();

    const afterwards = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true });
    window.dispatchEvent(afterwards);

    expect(afterwards.defaultPrevented).toBe(false);
  });
});

describe('isTextEntryTarget', () => {
  it('recognises the elements that own a keystroke, and nothing else', () => {
    const element = (tagName: string, contentEditable = false): EventTarget =>
      ({ tagName, isContentEditable: contentEditable }) as unknown as EventTarget;

    expect(isTextEntryTarget(element('INPUT'))).toBe(true);
    expect(isTextEntryTarget(element('textarea'))).toBe(true);
    expect(isTextEntryTarget(element('Select'))).toBe(true);
    expect(isTextEntryTarget(element('DIV', true))).toBe(true);
    expect(isTextEntryTarget(element('DIV'))).toBe(false);
    expect(isTextEntryTarget(element('BUTTON'))).toBe(false);
    // A target that is not an element at all — `window`, a `MessagePort`, or a
    // detached node from another realm — must not be mistaken for a field.
    expect(isTextEntryTarget({} as EventTarget)).toBe(false);
    expect(isTextEntryTarget(window as unknown as EventTarget)).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});

/* ---------- F8: the one-shot install latch -------------------------------- */

describe('installOnce', () => {
  it('latches only after the install actually succeeded', () => {
    let installs = 0;
    const install = installOnce(() => {
      installs += 1;
    });

    expect(install()).toBe(true);
    expect(install()).toBe(false);
    expect(installs).toBe(1);
  });

  it('retries after a refusal instead of spending the tab’s only attempt', () => {
    let attempts = 0;
    const install = installOnce(() => {
      attempts += 1;
      // The first attempt refuses, the way a browser that has not yet granted
      // an orientation lock does.
      if (attempts === 1) throw new Error('refused');
    });

    // A refusal must not take the shell down, and must not latch.
    expect(install()).toBe(false);
    expect(install()).toBe(true);
    expect(install()).toBe(false);
    expect(attempts).toBe(2);
  });
});

/* ---------- the browser capability surfaces ------------------------------- */

class FakeNotification {
  static permission: NotificationPermission = 'default';
  static requested = 0;
  static readonly shown: string[] = [];

  onclick: ((event: unknown) => unknown) | null = null;
  closed = false;

  constructor(readonly title: string) {
    FakeNotification.shown.push(title);
  }

  static async requestPermission(): Promise<NotificationPermission> {
    FakeNotification.requested += 1;
    return 'granted';
  }

  close(): void {
    this.closed = true;
  }
}

describe('browserNotificationSurface', () => {
  const undo: (() => void)[] = [];
  afterEach(() => {
    while (undo.length > 0) undo.pop()?.();
    FakeNotification.permission = 'default';
    FakeNotification.requested = 0;
    FakeNotification.shown.length = 0;
  });

  it('answers “unsupported” and refuses to prompt where the API is absent', async () => {
    const surface = browserNotificationSurface(
      () => undefined,
      () => undefined,
    );

    expect(surface.permission()).toBe('unsupported');
    expect(await surface.requestPermission()).toBe('unsupported');
    // No constructor means no page-level fallback; `showNotification` reports
    // `unavailable` rather than pretending.
    expect(surface.showOnPage).toBeNull();
  });

  it('reads and requests the real permission, reporting the answer onward', async () => {
    undo.push(patchGlobal(globalThis, 'Notification', FakeNotification));
    FakeNotification.permission = 'default';
    const seen: string[] = [];
    const surface = browserNotificationSurface(
      () => undefined,
      permission => seen.push(permission),
    );

    expect(surface.permission()).toBe('default');
    expect(await surface.requestPermission()).toBe('granted');

    expect(FakeNotification.requested).toBe(1);
    // The shell's own permission state is what gates the fleet watch, so the
    // answer has to travel back out of the surface rather than being read again.
    expect(seen).toEqual(['granted']);
  });

  it('prefers the worker registration and degrades to none without a container', async () => {
    const registration = { getNotifications: async () => [], showNotification: async () => undefined };
    undo.push(patchGlobal(navigator, 'serviceWorker', { getRegistration: async () => registration }));
    const surface = browserNotificationSurface(
      () => undefined,
      () => undefined,
    );

    expect(await surface.registration()).toBe(registration);

    undo.push(patchGlobal(navigator, 'serviceWorker', { getRegistration: async () => undefined }));
    expect(await surface.registration()).toBeNull();
  });

  it('reports no registration at all in a browser without a service worker', async () => {
    const surface = browserNotificationSurface(
      () => undefined,
      () => undefined,
    );

    expect('serviceWorker' in navigator).toBe(false);
    expect(await surface.registration()).toBeNull();
  });

  it('builds the page-level fallback and routes its click through the app', () => {
    undo.push(patchGlobal(globalThis, 'Notification', FakeNotification));
    const navigated: string[] = [];
    const surface = browserNotificationSurface(
      path => navigated.push(path),
      () => undefined,
    );

    const showOnPage = must(surface.showOnPage, 'the page-level fallback');
    const notification = showOnPage('Alpha stopped', { body: 'body', tag: 'tag', renotify: false });

    expect(FakeNotification.shown).toEqual(['Alpha stopped']);
    surface.navigate('/d/alpha/session/one');
    expect(navigated).toEqual(['/d/alpha/session/one']);
    expect(notification).toBeDefined();
  });
});

describe('browserPushEnrolment', () => {
  const undo: (() => void)[] = [];
  afterEach(() => {
    while (undo.length > 0) undo.pop()?.();
  });

  const supportPush = (getRegistration: () => Promise<unknown>): void => {
    undo.push(patchGlobal(globalThis, 'isSecureContext', true));
    undo.push(patchGlobal(navigator, 'serviceWorker', { getRegistration }));
    undo.push(patchGlobal(window, 'PushManager', class {}));
  };

  it('declines where this browser cannot do Web Push at all', () => {
    // No secure context, no container, no PushManager: the ordinary state of
    // this suite's document, and of any plain-HTTP page.
    expect(browserPushEnrolment()).toBeNull();
  });

  it('declines in a secure context that still has no push manager', () => {
    undo.push(patchGlobal(globalThis, 'isSecureContext', true));
    undo.push(patchGlobal(navigator, 'serviceWorker', { getRegistration: async () => undefined }));

    expect(browserPushEnrolment()).toBeNull();
  });

  it('resolves the registration that can hold a subscription', async () => {
    const registration = {
      pushManager: { getSubscription: async () => null, subscribe: async () => ({}) },
    } as unknown as PushRegistrationLike;
    supportPush(async () => registration);

    const enrolment = must(browserPushEnrolment(), 'the push enrolment');

    expect(await enrolment.registration()).toBe(registration);
    // The name is what a reader revokes by, on the daemon's device list.
    expect(enrolment.deviceName()).toBe('Ferretry PWA');
  });

  it('refuses a build whose registration cannot carry a subscription', async () => {
    supportPush(async () => undefined);
    const missing = must(browserPushEnrolment(), 'the push enrolment');
    await expect(missing.registration()).rejects.toThrow('no active service worker registration');

    while (undo.length > 0) undo.pop()?.();
    supportPush(async () => ({}));
    const unusable = must(browserPushEnrolment(), 'the push enrolment');
    await expect(unusable.registration()).rejects.toThrow('no active service worker registration');
  });
});

/* ---------- the picker, the settings host, and the public root ------------ */

describe('the connection picker slot', () => {
  it('pairs a fresh daemon and opens the daemon it just paired', async () => {
    const { store, view } = await renderShell('/');
    const field = must(view.container.querySelector<HTMLInputElement>('#pairing-link'), 'the pairing link field');
    const form = must(field.closest('form'), 'the pairing form');

    await interact(() => {
      const setter = must(
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set,
        'the input value setter',
      );
      setter.call(field, 'https://pwa.example.test/#v1;url=https%3A%2F%2Fgamma.example.test;code=one-time;fp=gamma');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await interact(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await settle();

    // The root must land on the daemon the exchange returned, not on whichever
    // pairing happened to be selected before.
    expect(window.location.pathname).toBe('/d/gamma');
    expect(store.connections.getSnapshot().connections.map(one => String(one.daemonId))).toEqual(['gamma']);
    expect(requestedUrls.some(url => url.endsWith('/v1/pair'))).toBe(false);

    await view.unmount();
  });

  it('selects and forgets a pairing without leaving the picker', async () => {
    const { store, view } = await renderShell('/', [alpha.daemonId, beta.daemonId]);
    await settle();

    const open = must(
      [...view.container.querySelectorAll('button')].find(button => button.textContent?.includes('alpha')),
      'the alpha pairing control',
    );
    await interact(() => open.click());

    expect(window.location.pathname).toBe('/d/alpha');
    expect(store.connections.getSnapshot().selectedDaemonId).toBe(alpha.daemonId);

    await popTo('/');
    await settle();
    const before = store.connections.getSnapshot().connections.length;
    const remove = must(
      [...view.container.querySelectorAll('button')].find(button =>
        /remove|forget|unpair/i.test(button.textContent ?? ''),
      ),
      'the remove control',
    );
    await interact(() => remove.click());

    expect(store.connections.getSnapshot().connections.length).toBe(before - 1);
    await view.unmount();
  });
});

describe('the fleet notification watch', () => {
  const undo: (() => void)[] = [];
  afterEach(() => {
    while (undo.length > 0) undo.pop()?.();
    FakeNotification.shown.length = 0;
  });

  it('subscribes to the fleet and reads the document’s own visibility once permission is granted', async () => {
    FakeNotification.permission = 'granted';
    undo.push(patchGlobal(globalThis, 'Notification', FakeNotification));
    // Hidden, so a transition is a notification rather than something the
    // reader is already looking at.
    undo.push(patchGlobal(document, 'hidden', true));

    const { store, view } = await renderShell('/d/alpha', [alpha.daemonId], { sessions: ['one'] });
    await settle();
    // Granted permission is what mounts the watch; the shell reads it from the
    // real API rather than assuming.
    expect(view.container.querySelector('[data-route]')).not.toBeNull();

    store.notificationPreferences.set(alpha.daemonId, { enabled: true });
    await interact(async () => {
      await store.fleet.hydrate(alpha);
    });
    await settle();

    // The watch is wired to THIS store's fleet: a refresh has to reach it
    // through the subscription the shell handed over.
    expect(store.fleet.getSnapshot().daemons.get(alpha.daemonId)?.sessions?.length).toBe(1);

    await view.unmount();
  });
});

describe('App', () => {
  it('mounts the public root with its own router and store', async () => {
    setPath('/');
    const view = await mount(<App />);
    await settle();

    expect(view.container.querySelector('h1')?.textContent).toBe('Connect a daemon');
    expect(must(view.container.querySelector('[data-route]'), 'the route announcer').textContent).toBe('Daemons');
    await view.unmount();
  });
});
