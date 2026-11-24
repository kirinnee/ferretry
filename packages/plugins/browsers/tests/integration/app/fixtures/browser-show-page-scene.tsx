/**
 * The entry for "the agent opened a page and the Browser panel shows it": the REAL `BrowserPanel` and `UnifiedBrowserSurface`, the
 * real status and action calls, over a fake daemon that keeps ONE PAGE PER VIEWER the way the daemon does (a viewer that has not
 * chosen one follows the session's own page). The only stand-in is the display pane: it asks for a viewer id when its stream "comes
 * up" (a moment after it mounts, as a socket does), and draws the title of the page its viewer is on.
 *
 *   window.__show(pageId)  the workspace's `show-page` intent, as the ferret page hands it to the panel
 *   window.__pageOf(viewer) the page that viewer is on, in the fake daemon
 *   window.__acts          every action the daemon was asked for, with the viewer it named
 *
 * ?theme=<family>-<mode>
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import type { PanelIntent } from '@ferretry/kernel/manifest';
import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserPanel } from '../../../../app/features/browser/browser-panel.tsx';
import type { RemoteBrowserPaneProps } from '../../../../app/features/browser/remote-browser-pane.tsx';
import { fetchRemoteBrowserStatus, runRemoteBrowserAction } from '../../../../app/lib/remote-browser.ts';
import type { BrowserDaemon } from '../../../../app/lib/scope.ts';
import type { BrowserAction, BrowserStatus } from '../../../../contract/wire/browser.ts';
import { paneState } from '../../../support/app/browser-pane-state.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

declare global {
  interface Window {
    __show: (pageId: string) => void;
    __pageOf: (viewer: string) => string;
    __acts: { action: string; pageId?: string; viewer: string | null }[];
  }
}

const PAGES = [
  { id: 'p1', url: 'https://example.invalid/claims', title: 'Claims queue' },
  { id: 'p2', url: 'https://example.invalid/invoices/88', title: 'Invoice 88' },
] as const;

/** The daemon: the session's own page, and the page each viewer chose. A viewer that chose nothing follows the session. */
let sessionPage = 'p1';
const chosen = new Map<string, string>();
window.__pageOf = viewer => chosen.get(viewer) ?? sessionPage;
window.__acts = [];

/** The page facts a status and an action's result share, for the page this viewer is on. */
const snapshotFor = (viewer: string | undefined) => {
  const active = viewer === undefined ? sessionPage : (chosen.get(viewer) ?? sessionPage);
  const page = PAGES.find(candidate => candidate.id === active) ?? PAGES[0];
  return {
    url: page.url,
    title: page.title,
    pages: PAGES.map(each => ({ ...each })),
    activePageId: page.id,
    canGoBack: false,
    canGoForward: false,
    pageState: 'ready',
  };
};

const statusFor = (viewer: string | undefined): BrowserStatus => {
  return {
    ...snapshotFor(viewer),
    sessionId: 'zoe',
    state: 'running',
    viewport: { width: 640, height: 480 },
    viewers: 2,
    persistentProfile: true,
    idleTimeoutSeconds: 900,
    capacity: { running: 1, maximum: 3 },
  } as BrowserStatus;
};

const client = {
  call: async (route: string, init?: { query?: Record<string, string>; body?: unknown }) => {
    const viewer = init?.query?.viewer;
    if (route === 'GET /v1/ferrets/:ferretId/browser') return statusFor(viewer);
    if (route === 'POST /v1/ferrets/:ferretId/browser') {
      const action = init?.body as BrowserAction;
      window.__acts.push({
        action: action.action,
        ...('pageId' in action ? { pageId: action.pageId } : {}),
        viewer: viewer ?? null,
      });
      if (action.action === 'activate-page') {
        if (viewer === undefined) sessionPage = action.pageId;
        else chosen.set(viewer, action.pageId);
      }
      return { status: statusFor(viewer), result: snapshotFor(viewer) };
    }
    throw new Error('nothing here');
  },
  subscribe: () => () => undefined,
} as unknown as PluginClient;
const daemon: BrowserDaemon = { daemonId: 'ws', client };

/** The display, as the shell has it: a viewer id comes a moment after it mounts, and the page it draws is that viewer's own. */
function StandInPane({ daemon: given, scope, onStateChange }: RemoteBrowserPaneProps) {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const read = useCallback(async () => setStatus(await fetchRemoteBrowserStatus(given, scope)), [given, scope]);
  const runAction = useCallback(
    (action: BrowserAction) => void runRemoteBrowserAction(given, scope, action).then(read),
    [given, scope, read],
  );
  useEffect(() => {
    const stream = window.setTimeout(() => {
      scope.viewer?.set('v1');
      void read();
    }, 300);
    return () => {
      window.clearTimeout(stream);
      scope.viewer?.set(undefined);
    };
  }, [scope, read]);
  useEffect(() => {
    onStateChange?.(paneState({ status, busy: false, error: null, runAction }));
  }, [status, onStateChange, runAction]);
  const running = status !== null && status.state === 'running' && status.pages.length > 0 ? status : null;
  const page = running?.pages.find(each => each.id === (running as { activePageId?: string }).activePageId);
  return (
    <section aria-label="Shared remote browser" className="flex min-h-0 flex-1 flex-col bg-surface p-4">
      <h2 data-shown-page={page?.id ?? ''}>{page?.title ?? 'Connecting…'}</h2>
    </section>
  );
}

function Scene() {
  const [intent, setIntent] = useState<PanelIntent | undefined>(undefined);
  useEffect(() => {
    let counter = 0;
    window.__show = target => {
      counter += 1;
      setIntent({ id: counter, action: 'show-page', target });
    };
  }, []);
  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <BrowserPanel
        daemon={daemon}
        sessionId="zoe"
        dependencies={{ PreviewFrame: () => null, RemotePane: StandInPane }}
        {...(intent === undefined ? {} : { intent })}
      />
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Scene />);
