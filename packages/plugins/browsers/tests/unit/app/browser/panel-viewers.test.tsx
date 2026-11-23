/**
 * B1 — one page per screen, drawn: two Browser panels on one ferret (a desktop pane and a phone sheet) each speak as the
 * viewer the daemon told its own display stream it is, so the status the daemon answers a panel is that panel's own page
 * and a tab chosen in one is not chosen in the other. A panel never makes an id up: before its stream is told one, it asks
 * as no viewer at all.
 */
import { describe, expect, it } from 'bun:test';
import { interact, mount, must } from '@ferretry/app/testing';
import type { PanelProps } from '@ferretry/kernel/manifest';
import { createElement, type FunctionComponent, Suspense } from 'react';
import app from '../../../../app/index.ts';
import manifest from '../../../../manifest.ts';
import { type BrowserStatus } from '../../../../contract/wire/browser.ts';
import { rememberBrowserEngine } from '../../../../app/features/browser/unified-browser-model.ts';
import { browserSessionScope } from '../../../../app/lib/scope.ts';
import { socketClient } from '../../../support/app/client.ts';
import { withDocument } from '../../../support/app/dom.ts';

await withDocument();
// A display only streams while its page is on screen.
Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });

const STATUS = 'GET /v1/ferrets/:ferretId/browser';
const ACT = 'POST /v1/ferrets/:ferretId/browser';

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
  });
};

const statusOn = (active: string): BrowserStatus =>
  ({
    sessionId: 'session-a',
    viewport: { width: 1280, height: 800 },
    viewers: 2,
    persistentProfile: true,
    idleTimeoutSeconds: 900,
    capacity: { running: 2, maximum: 3 },
    state: 'running',
    url: `https://example.test/${active}`,
    title: active,
    pages: [
      { id: 'p1', url: 'https://example.test/p1', title: 'p1' },
      { id: 'p2', url: 'https://example.test/p2', title: 'p2' },
    ],
    activePageId: active,
    pageState: 'ready',
    canGoBack: false,
    canGoForward: false,
  }) as unknown as BrowserStatus;

describe('B1 two Browser panels on one ferret', () => {
  it('should read, and act as, the viewer the daemon named its stream, and draw the page the daemon kept for it', async () => {
    // Arrange — a daemon that keeps a page per viewer id: the first to ask starts on p2, and p1 is chosen by an act.
    const views = new Map<string, string>();
    const seen: { route: string; action: string | undefined; viewer: string | undefined }[] = [];
    const sockets = socketClient((route, init) => {
      if (route === 'GET /v1/browser/state') return { state: 'stopped' };
      if (route === 'GET /v1/config/file') return { path: 'browsers.yaml', exists: true, text: '', etag: 'e' };
      if (route !== STATUS && route !== ACT) return new Error(`no route ${route}`);
      const viewer = init?.query?.viewer;
      seen.push({ route, action: (init?.body as { action?: string } | undefined)?.action, viewer });
      // A panel whose stream has not been named asks as no viewer: it is on the session's own page.
      const key = viewer ?? 'session';
      if (!views.has(key)) views.set(key, 'p2');
      const action = init?.body as { action?: string; pageId?: string } | undefined;
      if (route === ACT && action?.action === 'activate-page' && action.pageId !== undefined)
        views.set(key, action.pageId);
      const status = statusOn(views.get(key) as string);
      return route === ACT ? { status } : status;
    });
    const Panel = must(app.build?.({ manifest, client: sockets.client })?.panels?.browser, 'the browser panel');
    const open = () =>
      mount(
        createElement(
          Suspense,
          { fallback: null },
          createElement(Panel as FunctionComponent<PanelProps>, { subject: 'session-a' } as PanelProps),
        ),
      );
    // Both panels show the live display, so each opens a display stream of its own.
    rememberBrowserEngine(browserSessionScope({ daemonId: 'this-daemon' }, 'session-a'), 'remote');
    const desktop = await open();
    await settle();
    // The daemon names each panel's display stream as it opens: the desktop's first, then the phone's.
    await interact(() => {
      sockets.daemon.open();
      sockets.daemon.frame(JSON.stringify({ viewer: 'desktop-viewer' }));
    });
    await settle();
    const phone = await open();
    await settle();
    await interact(() => {
      sockets.daemon.open();
      sockets.daemon.frame(JSON.stringify({ viewer: 'phone-viewer' }));
    });
    await settle();
    /** The page a panel's bar says it is on. */
    const current = (container: Element): string | undefined =>
      /Browser pages — (.+)$/u.exec(
        container.querySelector('[data-browser-trigger="pages"]')?.getAttribute('aria-label') ?? '',
      )?.[1];

    // Act — the desktop opens the first page's tab.
    await interact(() =>
      must(desktop.container.querySelector<HTMLElement>('[data-browser-trigger="pages"]'), 'the pages trigger').click(),
    );
    await interact(() =>
      must(desktop.container.querySelector<HTMLElement>('[data-browser-page="p1"]'), 'the first page tab').click(),
    );
    await settle();

    // Assert — the act was the desktop's own viewer's, and the phone is still on the page it started on.
    expect(seen.filter(call => call.action === 'activate-page').map(call => call.viewer)).toEqual(['desktop-viewer']);
    // Nothing was ever asked as an id the daemon did not give.
    for (const call of seen) expect([undefined, 'desktop-viewer', 'phone-viewer']).toContain(call.viewer);
    expect(views.get('desktop-viewer')).toBe('p1');
    expect(views.get('phone-viewer') ?? 'p2').toBe('p2');
    expect(current(desktop.container)).toBe('p1');
    expect(current(phone.container)).toBe('p2');
    await desktop.unmount();
    await phone.unmount();
  });
});
