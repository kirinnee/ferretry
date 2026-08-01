import { beforeEach, describe, expect, it } from 'bun:test';
import type { BrowserAction, BrowserStatus } from '@ferretry/protocol';
import { useCallback, useEffect, useState, type ComponentType } from 'react';
import { browserDestination, type BrowserDestination } from '../../../src/features/browser/in-app-browser-model.ts';
import type { InAppBrowserFrameProps } from '../../../src/features/browser/in-app-browser.tsx';
import type {
  RemoteBrowserPaneProps,
  RemoteBrowserPaneState,
} from '../../../src/features/browser/remote-browser-pane.tsx';
import {
  browserEngineForSession,
  browserSessionMemory,
  rememberBrowserEngine,
  rememberBrowserIncoming,
  resetBrowserSurfaceSessions,
} from '../../../src/features/browser/unified-browser-model.ts';
import {
  UnifiedBrowserSurface,
  type UnifiedBrowserDependencies,
  type UnifiedBrowserSurfaceProps,
} from '../../../src/features/browser/unified-browser-surface.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { interact, mount, must, pressKey } from '../../support/dom.ts';
import { render, run } from '../../support/react.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'b' });
/** The adversarial pair: one session id, two daemons, two different Chromes. */
const scopeA = daemonSessionScope(daemonA, 'same-session');
const scopeB = daemonSessionScope(daemonB, 'same-session');

const link = (href: string): BrowserDestination => must(browserDestination(href), `destination for ${href}`);

const runningStatus = (
  overrides: {
    readonly url?: string;
    readonly title?: string;
    readonly canGoBack?: boolean;
    readonly canGoForward?: boolean;
    readonly pageState?: 'loading' | 'ready';
  } = {},
) =>
  ({
    sessionId: 'same-session',
    state: 'running',
    url: overrides.url ?? 'https://example.test/',
    title: overrides.title ?? 'Example',
    pages: [{ id: 'page-a', url: overrides.url ?? 'https://example.test/', title: overrides.title ?? 'Example' }],
    activePageId: 'page-a',
    canGoBack: overrides.canGoBack ?? true,
    canGoForward: overrides.canGoForward ?? false,
    pageState: overrides.pageState ?? 'ready',
    viewport: { width: 640, height: 480 },
    viewers: 1,
    persistentProfile: true,
    idleTimeoutSeconds: 600,
    capacity: { running: 1, maximum: 3 },
  }) satisfies BrowserStatus;

/**
 * A preview engine that records one entry per MOUNT. A cross-origin frame can
 * only be made to reload by remounting it, so the mount log is what proves the
 * surface asked for a reload rather than merely re-rendered.
 */
const fakePreviewEngine = () => {
  const opened: string[] = [];
  const Frame = ({ destination }: InAppBrowserFrameProps) => {
    useEffect(() => {
      opened.push(destination.href);
    }, [destination.href]);
    return <div data-fake-preview-frame={destination.href} />;
  };
  return { Frame, opened };
};

interface FakeRemoteEngine {
  readonly Pane: ComponentType<RemoteBrowserPaneProps>;
  /** Every action the surface dispatched into the pane's single engine. */
  readonly actions: BrowserAction[];
  readonly props: () => RemoteBrowserPaneProps;
  readonly mounted: () => boolean;
  readonly publish: (status: BrowserStatus | null, busy?: boolean) => Promise<void>;
}

/**
 * A remote engine that publishes what a real pane publishes and records what it
 * is asked to do — so these tests prove the surface drives ONE engine through
 * the pane's own dispatcher, never a transport of its own.
 */
const fakeRemoteEngine = (): FakeRemoteEngine => {
  const actions: BrowserAction[] = [];
  let seen: RemoteBrowserPaneProps | null = null;
  let live = false;
  let apply: ((status: BrowserStatus | null, busy: boolean) => void) | null = null;

  const Pane = (props: RemoteBrowserPaneProps) => {
    const { onStateChange } = props;
    const [snapshot, setSnapshot] = useState<{ status: BrowserStatus | null; busy: boolean }>({
      status: null,
      busy: false,
    });
    seen = props;
    apply = (status, busy) => setSnapshot({ status, busy });
    const runAction = useCallback((action: BrowserAction) => {
      actions.push(action);
    }, []);

    useEffect(() => {
      live = true;
      return () => {
        live = false;
        apply = null;
      };
    }, []);

    useEffect(() => {
      const state: RemoteBrowserPaneState = { status: snapshot.status, busy: snapshot.busy, error: null, runAction };
      onStateChange?.(state);
    }, [onStateChange, runAction, snapshot]);

    return <div data-fake-remote-pane="live" />;
  };

  return {
    Pane,
    actions,
    props: () => must(seen, 'remote pane props'),
    mounted: () => live,
    publish: async (status, busy = false) => {
      const publisher = must(apply, 'a mounted remote engine');
      await interact(() => publisher(status, busy));
    },
  };
};

/** Both engines, substituted together: no daemon, no socket, no network. */
const engines = () => {
  const preview = fakePreviewEngine();
  const remote = fakeRemoteEngine();
  const dependencies: UnifiedBrowserDependencies = { PreviewFrame: preview.Frame, RemotePane: remote.Pane };
  return { preview, remote, dependencies };
};

const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

const surface = (overrides: Partial<UnifiedBrowserSurfaceProps> = {}) => (
  <UnifiedBrowserSurface
    daemon={daemonA}
    scope={scopeA}
    streamTicket="ticket-1"
    presentation="pane"
    titleId="browser-title"
    onClose={() => undefined}
    {...overrides}
  />
);

const labelled = (container: HTMLElement, label: string): HTMLElement =>
  must(container.querySelector<HTMLElement>(`[aria-label="${label}"]`), `control labelled “${label}”`);

const named = (container: HTMLElement, text: string): HTMLButtonElement =>
  must(
    [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === text),
    `button named “${text}”`,
  );

const addressField = (container: HTMLElement): HTMLInputElement =>
  must(container.querySelector('input'), 'the address input');

const type = async (container: HTMLElement, value: string): Promise<void> => {
  const input = addressField(container);
  await interact(() => {
    nativeValueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const submit = async (container: HTMLElement): Promise<void> => {
  const form = must(container.querySelector('form'), 'the address form');
  await interact(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
};

const click = async (element: HTMLElement): Promise<void> => {
  await interact(() => element.click());
};

const openMenu = async (container: HTMLElement): Promise<HTMLElement> => {
  await click(labelled(container, 'Browser controls'));
  return must(container.querySelector<HTMLElement>('[role="dialog"]'), 'the browser controls menu');
};

const closeMenu = async (container: HTMLElement): Promise<void> => {
  await click(labelled(container, 'Browser controls'));
};

const previewHref = (container: HTMLElement): string | null =>
  container.querySelector('[data-fake-preview-frame]')?.getAttribute('data-fake-preview-frame') ?? null;

const alertText = (container: HTMLElement): string => container.querySelector('[role="alert"]')?.textContent ?? '';

beforeEach(resetBrowserSurfaceSessions);

describe('the unified browser surface', () => {
  it('refuses a scope that belongs to another daemon before any transport exists', () => {
    // Called directly: the guard runs before the first hook, which is the point.
    // A mismatched pair must never reach a request, a socket or a Chrome.
    expect(() =>
      UnifiedBrowserSurface({
        daemon: daemonA,
        scope: scopeB,
        streamTicket: null,
        presentation: 'pane',
        titleId: 'browser-title',
        onClose: () => undefined,
      }),
    ).toThrow('unified browser scope must belong to the paired daemon');
  });

  it('opens on the honest empty preview state and offers no login it cannot reach', async () => {
    const { dependencies } = engines();
    const withoutLogin = await mount(surface({ dependencies }));
    expect(withoutLogin.container.textContent).toContain('Where to?');
    expect(withoutLogin.container.textContent).not.toContain('Open browser login window');
    expect(must(withoutLogin.container.querySelector('h2'), 'the pane heading').id).toBe('browser-title');
    // Nothing to go back or forward to, and nothing to submit.
    expect(labelled(withoutLogin.container, 'Back in preview').hasAttribute('disabled')).toBe(true);
    expect(labelled(withoutLogin.container, 'Forward in preview').hasAttribute('disabled')).toBe(true);
    expect(named(withoutLogin.container, 'Go').disabled).toBe(true);
    await withoutLogin.unmount();

    const sheet = await mount(
      surface({
        presentation: 'sheet',
        dependencies,
        onOpenLoginWindow: async () => ({ state: 'closed', profilePrimed: false }),
      }),
    );
    expect(must(sheet.container.querySelector('h1'), 'the sheet heading').id).toBe('browser-title');
    expect(sheet.container.textContent).toContain('Open browser login window');
    await sheet.unmount();
  });

  it('resolves the address bar into the preview engine, with its own bounded history', async () => {
    const { preview, dependencies } = engines();
    const view = await mount(surface({ dependencies }));

    await type(view.container, 'example.test/a');
    await submit(view.container);
    expect(previewHref(view.container)).toBe('https://example.test/a');
    expect(labelled(view.container, 'Back in preview').hasAttribute('disabled')).toBe(true);

    await type(view.container, 'how do daemons pair');
    await submit(view.container);
    expect(previewHref(view.container)).toBe('https://duckduckgo.com/?q=how+do+daemons+pair');

    const back = labelled(view.container, 'Back in preview');
    expect(back.hasAttribute('disabled')).toBe(false);
    await click(back);
    expect(previewHref(view.container)).toBe('https://example.test/a');
    expect(addressField(view.container).value).toBe('https://example.test/a');

    const forward = labelled(view.container, 'Forward in preview');
    expect(forward.hasAttribute('disabled')).toBe(false);
    await click(forward);
    expect(previewHref(view.container)).toBe('https://duckduckgo.com/?q=how+do+daemons+pair');
    expect(labelled(view.container, 'Forward in preview').hasAttribute('disabled')).toBe(true);

    // Reload is the one thing a cross-origin frame cannot be asked politely to
    // do: the surface remounts it instead of pretending.
    await click(labelled(view.container, 'Reload preview'));
    expect(preview.opened).toEqual([
      'https://example.test/a',
      'https://duckduckgo.com/?q=how+do+daemons+pair',
      'https://example.test/a',
      'https://duckduckgo.com/?q=how+do+daemons+pair',
      'https://duckduckgo.com/?q=how+do+daemons+pair',
    ]);
    await view.unmount();
  });

  it('says what is missing instead of searching for a half-typed scheme', async () => {
    const { dependencies } = engines();
    const view = await mount(surface({ dependencies }));
    await type(view.container, 'https:');
    await submit(view.container);

    expect(alertText(view.container)).toContain('Keep typing');
    expect(previewHref(view.container)).toBeNull();
    await view.unmount();
  });

  it('never overwrites an address the reader is still typing', async () => {
    const { dependencies } = engines();
    const first = link('https://docs.example.test/one');
    const view = await mount(surface({ destination: first, dependencies }));
    const input = addressField(view.container);

    await interact(() => input.focus());
    await type(view.container, 'half-typed');
    await view.render(surface({ destination: link('https://docs.example.test/two'), dependencies }));

    expect(previewHref(view.container)).toBe('https://docs.example.test/two');
    expect(addressField(view.container).value).toBe('half-typed');

    // Once the reader is done editing, the next real move refills the bar.
    await interact(() => input.blur());
    await view.render(surface({ destination: link('https://docs.example.test/three'), dependencies }));
    expect(addressField(view.container).value).toBe('https://docs.example.test/three');
    await view.unmount();
  });

  it('remembers the chosen engine per (daemon, session) and resumes that daemon’s Chrome', async () => {
    const { remote, dependencies } = engines();
    const view = await mount(surface({ destination: link('https://docs.example.test/one'), dependencies }));

    const menu = await openMenu(view.container);
    await click(named(menu, 'Real'));

    expect(remote.mounted()).toBe(true);
    const props = remote.props();
    expect(props.daemon).toBe(daemonA);
    expect(props.scope).toBe(scopeA);
    expect(props.streamTicket).toBe('ticket-1');
    expect(props.isActive).toBe(true);
    // The surface owns the shared chrome, so the pane's own address row is off.
    expect(props.showNavigation).toBe(false);
    // The selector resumes Chrome's own history: no preview URL is smuggled in.
    expect(remote.actions).toEqual([{ action: 'open' }]);

    expect(browserEngineForSession(scopeA)).toBe('remote');
    // Daemon B owns no Chrome for this session id and must not inherit one.
    expect(browserEngineForSession(scopeB)).toBe('preview');
    // Choosing an engine may not forget which link this scope last received.
    expect(browserSessionMemory(scopeA)?.lastIncoming?.href).toBe('https://docs.example.test/one');
    await view.unmount();
  });

  it('detaches the retained surface it is told is hidden', async () => {
    rememberBrowserEngine(scopeA, 'remote');
    const { remote, dependencies } = engines();
    const view = await mount(surface({ isActive: false, dependencies }));

    expect(remote.props().isActive).toBe(false);
    await view.unmount();
  });

  it('reattaches a remembered remote engine, and adopts only a link that changed while it was gone', async () => {
    const stored = link('https://docs.example.test/one');
    rememberBrowserEngine(scopeA, 'remote');
    rememberBrowserIncoming(scopeA, stored);

    const reattaching = engines();
    const reopened = await mount(surface({ destination: stored, dependencies: reattaching.dependencies }));
    // The very same stored destination is not a fresh tap: keep the reader's place.
    expect(reattaching.remote.actions).toEqual([{ action: 'open' }]);
    await reopened.unmount();

    const adopting = engines();
    const changed = await mount(
      surface({ destination: link('https://docs.example.test/two'), dependencies: adopting.dependencies }),
    );
    expect(adopting.remote.actions).toEqual([{ action: 'open', url: 'https://docs.example.test/two' }]);
    await changed.unmount();
  });

  it('drives the remote engine from the shared toolbar and treats unknown history as usable', async () => {
    rememberBrowserEngine(scopeA, 'remote');
    const { remote, dependencies } = engines();
    const view = await mount(surface({ dependencies }));

    // A daemon that has not reported its history yet must not disable anything.
    expect(labelled(view.container, 'Back in real browser').hasAttribute('disabled')).toBe(false);
    expect(labelled(view.container, 'Forward in real browser').hasAttribute('disabled')).toBe(false);

    await remote.publish(runningStatus({ canGoBack: true, canGoForward: false }));
    expect(addressField(view.container).value).toBe('https://example.test/');
    expect(labelled(view.container, 'Back in real browser').hasAttribute('disabled')).toBe(false);
    expect(labelled(view.container, 'Forward in real browser').hasAttribute('disabled')).toBe(true);

    await click(labelled(view.container, 'Back in real browser'));
    await click(labelled(view.container, 'Reload real browser'));
    await type(view.container, 'https://other.test/page');
    await submit(view.container);

    expect(remote.actions).toEqual([
      { action: 'open' },
      { action: 'back' },
      { action: 'reload' },
      { action: 'navigate', url: 'https://other.test/page' },
    ]);

    await remote.publish(runningStatus({ canGoBack: false, canGoForward: true }));
    await click(labelled(view.container, 'Forward in real browser'));
    expect(remote.actions.at(-1)).toEqual({ action: 'forward' });
    expect(labelled(view.container, 'Back in real browser').hasAttribute('disabled')).toBe(true);
    await view.unmount();
  });

  it('reports the real engine’s own work and page title without claiming either', async () => {
    rememberBrowserEngine(scopeA, 'remote');
    const { remote, dependencies } = engines();
    const view = await mount(surface({ dependencies }));

    expect((await openMenu(view.container)).textContent).toContain('Shared Chrome · persistent session');
    await closeMenu(view.container);

    await remote.publish(runningStatus({ pageState: 'loading' }));
    expect(must(view.container.querySelector('[role="status"]'), 'the progress row').textContent).toContain(
      'Loading page…',
    );
    expect((await openMenu(view.container)).textContent).toContain('Loading page…');
    await closeMenu(view.container);

    await remote.publish(runningStatus({ title: 'Ferretry docs' }), true);
    expect(must(view.container.querySelector('[role="status"]'), 'the progress row').textContent).toContain('Working…');
    expect(labelled(view.container, 'Back in real browser').hasAttribute('disabled')).toBe(true);
    expect(named(view.container, 'Go').disabled).toBe(true);
    expect((await openMenu(view.container)).textContent).toContain('Working…');
    await closeMenu(view.container);

    await remote.publish(runningStatus({ title: 'Ferretry docs' }));
    expect((await openMenu(view.container)).textContent).toContain('Ferretry docs');
    expect(labelled(view.container, 'Browser controls').title).toBe('Ferretry docs');
    await view.unmount();
  });

  it('hands an incoming link to the selected engine only', async () => {
    rememberBrowserEngine(scopeA, 'remote');
    const { remote, dependencies } = engines();
    const view = await mount(surface({ dependencies }));
    await remote.publish(runningStatus());

    await view.render(surface({ destination: link('https://tapped.example.test/'), dependencies }));
    expect(remote.actions.at(-1)).toEqual({ action: 'open', url: 'https://tapped.example.test/' });

    // Preview keeps its own history: the tap went to Chrome, not to the reader.
    const menu = await openMenu(view.container);
    await click(named(menu, 'Preview'));
    expect(remote.mounted()).toBe(false);
    expect(view.container.textContent).toContain('Where to?');
    await view.unmount();
  });

  it('leaves the other engine alone when the preview reader receives a link', async () => {
    const { preview, remote, dependencies } = engines();
    const view = await mount(surface({ dependencies }));

    await view.render(surface({ destination: link('https://tapped.example.test/'), dependencies }));

    expect(preview.opened).toEqual(['https://tapped.example.test/']);
    expect(remote.actions).toEqual([]);
    expect(remote.mounted()).toBe(false);
    await view.unmount();
  });

  it('copies the current address into the real browser on explicit request', async () => {
    const { remote, dependencies } = engines();
    const view = await mount(surface({ destination: link('https://docs.example.test/one'), dependencies }));

    const menu = await openMenu(view.container);
    await click(labelled(menu, 'Open in real browser'));

    expect(remote.actions).toEqual([{ action: 'open', url: 'https://docs.example.test/one' }]);
    expect(browserEngineForSession(scopeA)).toBe('remote');
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    await view.unmount();
  });

  it('still resumes Chrome when there is no address to carry into it', async () => {
    const { remote, dependencies } = engines();
    const view = await mount(surface({ dependencies }));

    const menu = await openMenu(view.container);
    await click(labelled(menu, 'Open in real browser'));

    expect(remote.actions).toEqual([{ action: 'open' }]);
    await view.unmount();
  });

  it('offers the external escape hatch only for an address that has one', async () => {
    const { dependencies } = engines();
    const empty = await mount(surface({ dependencies }));
    const emptyMenu = await openMenu(empty.container);
    const refused = labelled(emptyMenu, 'This browser address cannot be opened externally');
    expect(refused.tagName).toBe('BUTTON');
    expect(refused.hasAttribute('disabled')).toBe(true);
    await empty.unmount();

    const view = await mount(surface({ destination: link('https://docs.example.test/one'), dependencies }));
    const menu = await openMenu(view.container);
    const external = labelled(menu, 'Open externally in a new tab');
    expect(external.getAttribute('href')).toBe('https://docs.example.test/one');
    expect(external.getAttribute('rel')).toBe('noreferrer');
    // The default action is the browser's own new tab; only the menu-closing
    // handler belongs to this surface, so the navigation is cancelled here.
    await interact(() => {
      external.addEventListener('click', event => event.preventDefault(), { once: true });
      external.click();
    });
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    await view.unmount();
  });

  it('closes the surface from the menu, once', async () => {
    const { dependencies } = engines();
    const closes: number[] = [];
    const view = await mount(surface({ dependencies, onClose: () => closes.push(1) }));

    const menu = await openMenu(view.container);
    await click(labelled(menu, 'Done browsing'));

    expect(closes).toEqual([1]);
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    await view.unmount();
  });

  it('dismisses the controls menu on an outside pointer, and on Escape with focus returned', async () => {
    const { dependencies } = engines();
    const view = await mount(surface({ dependencies }));

    await openMenu(view.container);
    await interact(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();

    const menu = await openMenu(view.container);
    // A pointer inside the menu leaves it open.
    await interact(() => {
      menu.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(view.container.querySelector('[role="dialog"]')).not.toBeNull();

    await interact(async () => {
      pressKey(document, 'Escape');
      await new Promise(resolve => {
        requestAnimationFrame(() => resolve(undefined));
      });
    });
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(labelled(view.container, 'Browser controls'));
    await view.unmount();
  });

  it('re-identifies itself when the surface is re-scoped to another daemon', async () => {
    rememberBrowserEngine(scopeA, 'remote');
    const { remote, dependencies } = engines();
    const view = await mount(surface({ dependencies }));
    await remote.publish(runningStatus({ url: 'https://daemon-a-page.test/' }));
    expect(addressField(view.container).value).toBe('https://daemon-a-page.test/');

    await view.render(surface({ daemon: daemonB, scope: scopeB, dependencies }));

    // Daemon B has no remembered engine and no Chrome: nothing of A's survives.
    expect(remote.mounted()).toBe(false);
    expect(addressField(view.container).value).toBe('');
    expect(view.container.textContent).toContain('Where to?');

    const menu = await openMenu(view.container);
    await click(named(menu, 'Real'));
    expect(remote.props().daemon).toBe(daemonB);
    expect(remote.props().scope).toBe(scopeB);
    expect(remote.actions).toEqual([{ action: 'open' }, { action: 'open' }]);
    expect(browserEngineForSession(scopeB)).toBe('remote');
    expect(browserEngineForSession(scopeA)).toBe('remote');
    await view.unmount();
  });

  it('reports a browser-login window it could not open', async () => {
    const { dependencies } = engines();
    const unknown = await mount(
      surface({
        dependencies,
        onOpenLoginWindow: async () => ({ state: 'unknown', error: 'the daemon could not be reached' }),
      }),
    );
    await click(named(unknown.container, 'Open browser login window'));
    expect(alertText(unknown.container)).toContain('the daemon could not be reached');
    await unknown.unmount();

    const silent = await mount(
      surface({ dependencies, onOpenLoginWindow: async () => ({ state: 'error', profilePrimed: false }) }),
    );
    await click(named(silent.container, 'Open browser login window'));
    expect(alertText(silent.container)).toContain('Could not open the browser login window.');
    await silent.unmount();

    const refused = await mount(
      surface({ dependencies, onOpenLoginWindow: () => Promise.reject(new Error('login window is already open')) }),
    );
    await click(named(refused.container, 'Open browser login window'));
    expect(alertText(refused.container)).toContain('login window is already open');
    await refused.unmount();
  });

  it('says the login window is opening while the daemon is still answering', async () => {
    const { dependencies } = engines();
    let release: (() => void) | null = null;
    const view = await mount(
      surface({
        dependencies,
        onOpenLoginWindow: () =>
          new Promise(resolve => {
            release = () => resolve({ state: 'opening', profilePrimed: false });
          }),
      }),
    );

    await click(named(view.container, 'Open browser login window'));
    expect(view.container.textContent).toContain('Opening login window…');

    await interact(async () => {
      must(release, 'the pending login request')();
      await Promise.resolve();
    });
    expect(view.container.textContent).toContain('Open browser login window');
    expect(alertText(view.container)).toBe('');
    await view.unmount();
  });

  it('composes the real preview frame and the real remote pane by default', async () => {
    // Rendered through the shallow renderer: the real engines are wired, and the
    // default preview frame is the sandboxed iframe rather than a stand-in.
    const renderer = render(surface({ destination: link('https://docs.example.test/one') }));
    const frame = renderer.root.findByType('iframe');

    expect(frame.props.src).toBe('https://docs.example.test/one');
    expect(frame.props.sandbox).toContain('allow-scripts');
    expect(renderer.root.findAllByProps({ 'data-fake-remote-pane': 'live' })).toHaveLength(0);
    // Unmounted like every other tree here: a retained renderer would keep this
    // surface's document listeners alive for whatever suite runs next.
    run(() => renderer.unmount());
  });
});
