/**
 * The browser side panel with pages in TWO browser identities: the REAL page strip, surface header and remote pane (over a
 * fake transport and a fake display socket), the way a session workspace composes a browser tab. Synthetic sites, no network.
 *
 *   ?theme=<family>-<mode>
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import { createRoot } from 'react-dom/client';
import { BrowserSurfaceList } from '../../../../app/features/browser/browser-surface-list.tsx';
import {
  RemoteBrowserPane,
  type RemoteBrowserPaneProps,
} from '../../../../app/features/browser/remote-browser-pane.tsx';
import type { RemoteBrowserSocket } from '../../../../app/features/browser/remote-browser-viewer.tsx';
import { rememberBrowserEngine } from '../../../../app/features/browser/unified-browser-model.ts';
import { UnifiedBrowserSurface } from '../../../../app/features/browser/unified-browser-surface.tsx';
import { type BrowserDaemon, browserSessionScope } from '../../../../app/lib/scope.ts';
import type { BrowserActionResult, BrowserStatus } from '../../../../contract/wire/browser.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const daemon: BrowserDaemon = { daemonId: 'daemon-identities', client: {} as PluginClient };
const scope = browserSessionScope(daemon, 'identities-session');
rememberBrowserEngine(scope, 'remote');

const status = {
  sessionId: 'identities-session',
  state: 'running',
  url: 'https://billing.example.invalid/invoices',
  title: 'Invoices',
  pages: [
    {
      id: 'p1',
      name: 'app',
      url: 'https://app.example.invalid/home',
      title: 'Home',
      ownerName: 'Hadi',
      identity: 'agent',
    },
    {
      id: 'work-p1',
      name: 'billing',
      url: 'https://billing.example.invalid/invoices',
      title: 'Invoices',
      ownerName: 'Hadi',
      identity: 'work',
    },
    {
      id: 'work-p2',
      name: 'docs',
      url: 'https://docs.example.invalid/guide',
      title: 'Guide',
      ownerName: 'Hadi',
      identity: 'work',
    },
  ],
  activePageId: 'work-p1',
  canGoBack: true,
  canGoForward: false,
  pageState: 'ready',
  viewport: { width: 591, height: 486 },
  viewers: 1,
  persistentProfile: true,
  idleTimeoutSeconds: 900,
  capacity: { running: 3, maximum: 60 },
  lastActor: { kind: 'agent', at: '2026-11-27T22:00:00.000Z', action: 'type' },
} as unknown as BrowserStatus;

const transport = {
  readStatus: async () => status,
  runAction: async (): Promise<BrowserActionResult> => ({ status }) as BrowserActionResult,
};

/** A display that opens and stays quiet. */
const socketFactory = (): RemoteBrowserSocket => {
  const listeners = new Map<string, ((event: Event) => void)[]>();
  setTimeout(() => {
    for (const listener of listeners.get('open') ?? []) listener(new Event('open'));
  }, 0);
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

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="flex h-dvh min-h-0 flex-col bg-bg">
    <div className="flex min-h-0 flex-1 flex-col" data-workspace-browser="app">
      <UnifiedBrowserSurface
        daemon={daemon}
        scope={scope}
        presentation="pane"
        titleId="browser-title"
        onClose={() => undefined}
        dependencies={{ PreviewFrame: () => null, RemotePane: Pane }}
        host={{
          name: 'billing',
          control: {
            driver: { name: 'Hadi' },
            ask: null,
            takenOver: false,
            onTakeOver: () => undefined,
            onHandBack: () => undefined,
            onDismissAsk: () => undefined,
          },
          pages: (
            <BrowserSurfaceList
              driverFor={page => (page.id === 'work-p1' ? { name: 'Hadi' } : null)}
              onClosePage={() => undefined}
              onNewPage={() => undefined}
              onOpenPage={() => undefined}
              sessionName="Hadi"
              status={status}
              takenOver={() => false}
              selectedPageId="work-p1"
            />
          ),
        }}
      />
    </div>
  </div>,
);
