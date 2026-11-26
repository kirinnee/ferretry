/**
 * The browser entry for "the shared-browser pane is jumpy": the REAL `UnifiedBrowserSurface` header, the REAL
 * `RemoteBrowserStatusBar` and `RemoteBrowserControls`, over a stand-in pane whose page view is a
 * plain box (nothing here reads a network). The page flips the same two facts the daemon does —
 * `window.__setBusy(true|false)` and `window.__setLoading(true|false)` — and samples the page view's top
 * edge on every animation frame into `window.__tops`.
 *
 *   ?theme=<family>-<mode>
 *   &connection=<connected|connecting|disconnected|detached>   the display link the status row speaks of (default connected)
 *   &actor=none   a browser nobody has driven yet (the "No input yet" chip)
 *   &text=larger   the Larger text size (the factor the Text size setting publishes on the root)
 *   &loading=1    the page starts out loading (the "Loading page…" label)
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  RemoteBrowserControls,
  type RemoteBrowserConnection,
  RemoteBrowserStatusBar,
} from '../../../../app/features/browser/remote-browser-chrome.tsx';
import type { RemoteBrowserPaneProps } from '../../../../app/features/browser/remote-browser-pane.tsx';
import { rememberBrowserEngine } from '../../../../app/features/browser/unified-browser-model.ts';
import { UnifiedBrowserSurface } from '../../../../app/features/browser/unified-browser-surface.tsx';
import { type BrowserDaemon, browserSessionScope } from '../../../../app/lib/scope.ts';
import type { BrowserAction, BrowserStatus } from '../../../../contract/wire/browser.ts';
import { paneState } from '../../../support/app/browser-pane-state.ts';

const params = new URLSearchParams(window.location.search);
// `theme` is <style>-<mode>; the style, its own default palette and the mode are what the stylesheet reads.
const [style = 'studio', mode = 'light'] = (params.get('theme') ?? 'studio-light').split('-');
const PALETTE: Readonly<Record<string, string>> = { studio: 'studio', genz: 'vaporwave', neumorphism: 'afterglow' };
document.documentElement.dataset.theme = `${style}-${mode}`;
document.documentElement.dataset.style = style;
document.documentElement.dataset.palette = PALETTE[style] ?? 'studio';
document.documentElement.dataset.mode = mode;
const connection = (params.get('connection') ?? 'connected') as RemoteBrowserConnection;
const driven = params.get('actor') !== 'none';
if (params.get('text') === 'larger') {
  document.documentElement.dataset.textScale = 'larger';
  document.documentElement.style.setProperty('--fy-text-scale', '1.25');
}
const startsLoading = params.get('loading') === '1';

declare global {
  interface Window {
    __setBusy: (busy: boolean) => void;
    __setLoading: (loading: boolean) => void;
    __tops: { page: number[]; controls: number[] };
  }
}

const daemon: BrowserDaemon = { daemonId: 'daemon-jumpy', client: {} as PluginClient };
const scope = browserSessionScope(daemon, 'jumpy-session');
rememberBrowserEngine(scope, 'remote');

const status = (loading: boolean): BrowserStatus =>
  ({
    sessionId: 'jumpy-session',
    state: 'running',
    url: 'https://example.invalid/claims/new',
    title: 'New Claim',
    pages: [{ id: 'p1', url: 'https://example.invalid/claims/new', title: 'New Claim' }],
    activePageId: 'p1',
    canGoBack: true,
    canGoForward: false,
    pageState: loading ? 'loading' : 'ready',
    viewport: { width: 591, height: 486 },
    viewers: 1,
    persistentProfile: true,
    idleTimeoutSeconds: 900,
    capacity: { running: 1, maximum: 3 },
    ...(driven ? { lastActor: { kind: 'agent', at: '2026-10-30T22:00:00.000Z', action: 'type' } } : {}),
    proxy: { url: 'http://proxy.invalid:8080', authenticated: false, bypassCount: 0 },
  }) as unknown as BrowserStatus;

function StandInPane({ onStateChange }: RemoteBrowserPaneProps) {
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(startsLoading);
  const runAction = useCallback((_action: BrowserAction) => undefined, []);
  const current = useMemo(() => status(loading), [loading]);

  useEffect(() => {
    window.__setBusy = setBusy;
    window.__setLoading = setLoading;
  }, []);
  useEffect(() => {
    onStateChange?.(paneState({ status: current, busy, error: null, runAction }));
  }, [busy, current, onStateChange, runAction]);

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface"
      aria-label="Shared remote browser"
    >
      <RemoteBrowserStatusBar status={current} connection={connection} busy={busy} />
      <div data-controls="">
        <RemoteBrowserControls
          status={current}
          connection={connection}
          busy={busy}
          fit
          viewportMode="responsive"
          onAction={runAction}
          onToggleFit={() => undefined}
          onToggleViewportMode={() => undefined}
          onPasteFromClipboard={() => undefined}
        />
      </div>
      <div data-page-view="" className="min-h-[240px] flex-1 bg-code-bg" />
    </section>
  );
}

window.__tops = { page: [], controls: [] };
const sample = (): void => {
  const page = document.querySelector('[data-page-view]')?.getBoundingClientRect().top;
  const controls = document.querySelector('[data-controls]')?.getBoundingClientRect().top;
  if (page !== undefined) window.__tops.page.push(page);
  if (controls !== undefined) window.__tops.controls.push(controls);
  requestAnimationFrame(sample);
};
requestAnimationFrame(sample);

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="flex h-dvh min-h-0 flex-col">
    <UnifiedBrowserSurface
      daemon={daemon}
      scope={scope}
      presentation="pane"
      titleId="browser-title"
      onClose={() => undefined}
      dependencies={{ PreviewFrame: () => null, RemotePane: StandInPane }}
    />
  </div>,
);
