/**
 * B1 — one page per screen, drawn: two Browser panels on one ferret (a desktop pane and a phone sheet) each speak as a
 * viewer of their own, so the status the daemon answers a panel is that panel's own page and a tab chosen in one is not
 * chosen in the other.
 */
import { describe, expect, it } from 'bun:test';
import { interact, mount, must } from '@ferretry/app/testing';
import type { PanelProps } from '@ferretry/kernel/manifest';
import { createElement, type FunctionComponent, Suspense } from 'react';
import app from '../../../../app/index.ts';
import manifest from '../../../../manifest.ts';
import { BrowserViewerIdSchema, type BrowserStatus } from '../../../../contract/wire/browser.ts';
import { recordingClient } from '../../../support/app/client.ts';
import { withDocument } from '../../../support/app/dom.ts';

await withDocument();

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
  it('should read, and act as, a viewer each, and draw the page the daemon kept for that viewer', async () => {
    // Arrange — a daemon that keeps a page per viewer id: the first to ask starts on p2, and p1 is chosen by an act.
    const views = new Map<string, string>();
    const seen: { route: string; viewer: string | undefined }[] = [];
    const { client } = recordingClient((route, init) => {
      if (route === 'GET /v1/browser/state') return { state: 'stopped' };
      if (route === 'GET /v1/config/file') return { path: 'browsers.yaml', exists: true, text: '', etag: 'e' };
      if (route !== STATUS && route !== ACT) return new Error(`no route ${route}`);
      const viewer = init?.query?.viewer;
      seen.push({ route, viewer });
      if (viewer === undefined) return new Error('a panel asked as no viewer');
      if (!views.has(viewer)) views.set(viewer, 'p2');
      const action = init?.body as { action?: string; pageId?: string } | undefined;
      if (route === ACT && action?.action === 'activate-page' && action.pageId !== undefined)
        views.set(viewer, action.pageId);
      const status = statusOn(views.get(viewer) as string);
      return route === ACT ? { status } : status;
    });
    const Panel = must(app.build?.({ manifest, client })?.panels?.browser, 'the browser panel');
    const open = () =>
      mount(
        createElement(
          Suspense,
          { fallback: null },
          createElement(Panel as FunctionComponent<PanelProps>, { subject: 'session-a' } as PanelProps),
        ),
      );
    const desktop = await open();
    const phone = await open();
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

    // Assert — two viewers, each a plain id, and the phone still on the page it started on.
    const ids = [...new Set(seen.map(call => call.viewer))];
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(BrowserViewerIdSchema.safeParse(id).success).toBe(true);
    expect(seen.filter(call => call.route === ACT).map(call => call.viewer)).toEqual([ids[0]]);
    expect(current(desktop.container)).toBe('p1');
    expect(current(phone.container)).toBe('p2');
    await desktop.unmount();
    await phone.unmount();
  });
});
