/**
 * The browser entry for "the browser side tab": the REAL page strip, the REAL surface header and the REAL
 * remote pane (over a fake transport and a fake display socket), composed the way the session workspace
 * composes a browser tab. Nothing here reads a network.
 *
 *   ?theme=<family>-<mode>&state=idle|driving|owner|ask|challenge|error|disconnected|stopped
 */

import { createRoot } from 'react-dom/client';
import type { BrowserActionResult, BrowserStatus } from '@ferretry/protocol';
import { BrowserSurfaceList } from '../../../src/features/browser/browser-surface-list.tsx';
import { RemoteBrowserPane, type RemoteBrowserPaneProps } from '../../../src/features/browser/remote-browser-pane.tsx';
import type { RemoteBrowserSocket } from '../../../src/features/browser/remote-browser-viewer.tsx';
import { rememberBrowserEngine } from '../../../src/features/browser/unified-browser-model.ts';
import { UnifiedBrowserSurface } from '../../../src/features/browser/unified-browser-surface.tsx';
import { SurfaceFrame } from '../../../src/features/workspace/surface-frame.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const state = params.get('state') ?? 'idle';

const daemon = daemonConnection({ daemonId: 'daemon-tab', baseUrl: 'https://tab.invalid', deviceId: 'd' });
const scope = daemonSessionScope(daemon, 'tab-session');
rememberBrowserEngine(scope, 'remote');

const running = (): BrowserStatus =>
  ({
    sessionId: 'tab-session',
    state: 'running',
    url: 'https://example.invalid/claims/new',
    title: 'New Claim',
    pages: [
      {
        id: 'p1',
        name: 'app',
        url: 'https://example.invalid/claims/new',
        title: 'New Claim',
        ownerName: 'Hadi',
        ...(state === 'challenge' ? { challenge: { provider: 'cloudflare' } } : {}),
      },
      { id: 'p2', url: 'https://docs.invalid/guide', title: 'Guide', ownerName: 'Hadi' },
    ],
    activePageId: 'p1',
    canGoBack: true,
    canGoForward: false,
    pageState: state === 'error' ? 'error' : 'ready',
    ...(state === 'error' ? { pageError: 'The page could not be loaded (net::ERR_CONNECTION_REFUSED).' } : {}),
    viewport: { width: 591, height: 486 },
    viewers: 1,
    persistentProfile: true,
    idleTimeoutSeconds: 900,
    capacity: { running: 1, maximum: 3 },
    lastActor:
      state === 'owner'
        ? { kind: 'human', at: '2026-10-30T22:00:00.000Z', action: 'click' }
        : state === 'idle' || state === 'stopped'
          ? undefined
          : { kind: 'agent', at: '2026-10-30T22:00:00.000Z', action: 'type' },
    proxy: { url: 'http://proxy.invalid:8080', authenticated: false, bypassCount: 0 },
  }) as BrowserStatus;

const stopped = (): BrowserStatus =>
  ({
    sessionId: 'tab-session',
    state: 'stopped',
    pages: [],
    viewport: { width: 591, height: 486 },
    viewers: 0,
    persistentProfile: true,
    idleTimeoutSeconds: 900,
    capacity: { running: 0, maximum: 3 },
  }) as BrowserStatus;

const current = state === 'stopped' ? stopped() : running();

const transport = {
  readStatus: async () => current,
  runAction: async (): Promise<BrowserActionResult> => ({ status: current }) as BrowserActionResult,
};

/** A display that opens and stays quiet, or closes at once (`disconnected`). */
const socketFactory = (): RemoteBrowserSocket => {
  const listeners = new Map<string, ((event: Event) => void)[]>();
  const fire = (type: string, event: Event): void => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  setTimeout(
    () =>
      state === 'disconnected'
        ? fire('close', new CloseEvent('close', { code: 1000 }))
        : fire('open', new Event('open')),
    0,
  );
  return {
    readyState: 1,
    binaryType: 'blob',
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    send: () => undefined,
    close: () => undefined,
  };
};

function Pane(props: RemoteBrowserPaneProps) {
  return (
    <RemoteBrowserPane
      {...props}
      transport={transport}
      socketFactory={socketFactory}
      createObjectUrl={() => ''}
      revokeObjectUrl={() => undefined}
    />
  );
}

const driver = state === 'driving' || state === 'error' ? { name: 'Hadi' } : null;
const ask = state === 'ask' ? { agent: 'Hadi', message: 'Sign in to the claims portal, then hand it back.' } : null;

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="flex h-dvh min-h-0 flex-col bg-bg">
    <SurfaceFrame dataBrowser="app">
      {fullscreen => (
        <UnifiedBrowserSurface
          daemon={daemon}
          scope={scope}
          presentation="pane"
          titleId="browser-title"
          onClose={() => undefined}
          dependencies={{ PreviewFrame: () => null, RemotePane: Pane }}
          host={{
            name: 'app',
            fullscreen,
            control: {
              driver,
              ask,
              takenOver: state === 'owner',
              onTakeOver: () => undefined,
              onHandBack: () => undefined,
              onDismissAsk: () => undefined,
            },
            pages: (
              <BrowserSurfaceList
                driverFor={page => (page.id === 'p1' ? driver : null)}
                onClosePage={() => undefined}
                onNewPage={() => undefined}
                onOpenPage={() => undefined}
                sessionName="Hadi"
                status={current}
                takenOver={page => page.id === 'p1' && state === 'owner'}
                selectedPageId="p1"
              />
            ),
          }}
        />
      )}
    </SurfaceFrame>
  </div>,
);
